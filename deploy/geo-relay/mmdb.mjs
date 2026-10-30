// A reader for MaxMind DB files (the .mmdb format DB-IP publishes its city database in).
// It follows the format spec at https://maxmind.github.io/MaxMind-DB/ and needs nothing
// beyond Node: the whole file is held in memory and each lookup walks the search tree.

import { isIP } from 'node:net'

const METADATA_MARKER = Buffer.from('abcdef4d61784d696e642e636f6d', 'hex')
const DATA_SEPARATOR = 16

export class MmdbError extends Error {}

/** Opens a database held in a Buffer. Throws MmdbError if it is not a valid file. */
export function openMmdb(buffer) {
  const markerAt = buffer.lastIndexOf(METADATA_MARKER)
  if (markerAt < 0) throw new MmdbError('Not a MaxMind DB file: no metadata.')
  const metadataStart = markerAt + METADATA_MARKER.length
  const metadata = new Decoder(buffer, metadataStart).decode(metadataStart).value
  const { node_count: nodeCount, record_size: recordSize, ip_version: ipVersion } = metadata
  if (metadata.binary_format_major_version !== 2)
    throw new MmdbError(`Unsupported format version ${metadata.binary_format_major_version}.`)
  if (![24, 28, 32].includes(recordSize))
    throw new MmdbError(`Unsupported record size ${recordSize}.`)
  const nodeBytes = (recordSize * 2) / 8
  const treeSize = nodeCount * nodeBytes
  if (treeSize + DATA_SEPARATOR > markerAt) throw new MmdbError('The search tree is cut short.')
  const dataStart = treeSize + DATA_SEPARATOR
  const data = new Decoder(buffer, dataStart)

  const record = (node, bit) => {
    const at = node * nodeBytes
    if (recordSize === 24) return bit ? buffer.readUIntBE(at + 3, 3) : buffer.readUIntBE(at, 3)
    if (recordSize === 32) return bit ? buffer.readUInt32BE(at + 4) : buffer.readUInt32BE(at)
    // 28 bits: the middle byte holds the top four bits of each record.
    const middle = buffer[at + 3]
    return bit
      ? ((middle & 0x0f) << 24) | buffer.readUIntBE(at + 4, 3)
      : ((middle & 0xf0) << 20) | buffer.readUIntBE(at, 3)
  }

  // IPv4 addresses live under ::/96 in an IPv6 tree.
  let ipv4Start = 0
  if (ipVersion === 6) {
    for (let depth = 0; depth < 96 && ipv4Start < nodeCount; depth++)
      ipv4Start = record(ipv4Start, 0)
  }

  /** The record for an address and the length of the network it matched, or null. */
  function lookupWithPrefix(ip) {
    const bytes = addressBytes(ip)
    if (!bytes) return null
    if (bytes.length === 16 && ipVersion === 4) return null
    let node = bytes.length === 4 && ipVersion === 6 ? ipv4Start : 0
    const bits = bytes.length * 8
    let depth = 0
    for (; depth < bits && node < nodeCount; depth++) {
      const bit = (bytes[depth >> 3] >> (7 - (depth & 7))) & 1
      node = record(node, bit)
    }
    if (node === nodeCount || node < nodeCount) return null
    const offset = node - nodeCount - DATA_SEPARATOR
    if (dataStart + offset >= markerAt) throw new MmdbError('A record points past the data.')
    return { record: data.decode(dataStart + offset).value, prefixLength: depth }
  }

  return {
    metadata,
    lookup: (ip) => lookupWithPrefix(ip)?.record ?? null,
    lookupWithPrefix,
  }
}

/** The address as 4 or 16 bytes, or null if it is not an IP address. */
export function addressBytes(ip) {
  if (typeof ip !== 'string') return null
  const text = ip
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
  const version = isIP(text)
  if (version === 4) return Uint8Array.from(text.split('.').map(Number))
  if (version !== 6) return null
  // Expand "::" and a trailing dotted IPv4 part into eight groups.
  let groups = text.split(':')
  const last = groups[groups.length - 1]
  if (last.includes('.')) {
    const [a, b, c, d] = last.split('.').map(Number)
    groups.splice(groups.length - 1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16))
  }
  const gap = groups.indexOf('')
  if (gap >= 0) {
    const head = groups.slice(0, gap).filter(Boolean)
    const tail = groups.slice(groups.lastIndexOf('') + 1).filter(Boolean)
    groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
  }
  const bytes = new Uint8Array(16)
  groups.forEach((group, index) => {
    const value = parseInt(group, 16)
    bytes[index * 2] = value >> 8
    bytes[index * 2 + 1] = value & 0xff
  })
  // An IPv4-mapped address (::ffff:a.b.c.d) is looked up as the IPv4 address.
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff)
    return bytes.slice(12)
  return bytes
}

const TYPES = [
  'extended',
  'pointer',
  'string',
  'double',
  'bytes',
  'uint16',
  'uint32',
  'map',
  'int32',
  'uint64',
  'uint128',
  'array',
  'container',
  'end',
  'boolean',
  'float',
]

/** Decodes the data section. Offsets in pointers are relative to `base`. */
class Decoder {
  constructor(buffer, base) {
    this.buffer = buffer
    this.base = base
  }

  decode(at) {
    const buffer = this.buffer
    if (at >= buffer.length) throw new MmdbError('Data runs past the end of the file.')
    const control = buffer[at++]
    let type = TYPES[control >> 5]
    if (type === 'pointer') {
      const { offset, next } = this.pointer(control, at)
      const target = this.decode(this.base + offset)
      if (target.pointer) throw new MmdbError('A pointer points to a pointer.')
      return { value: target.value, next, pointer: true }
    }
    if (type === 'extended') {
      type = TYPES[buffer[at++] + 7]
      if (!type || ['extended', 'pointer', 'string', 'double'].includes(type))
        throw new MmdbError('Unknown data type.')
    }
    let size = control & 0x1f
    if (size === 29) size = 29 + buffer[at++]
    else if (size === 30) {
      size = 285 + buffer.readUInt16BE(at)
      at += 2
    } else if (size === 31) {
      size = 65821 + buffer.readUIntBE(at, 3)
      at += 3
    }
    switch (type) {
      case 'map': {
        const value = {}
        for (let index = 0; index < size; index++) {
          const key = this.decode(at)
          const entry = this.decode(key.next)
          value[key.value] = entry.value
          at = entry.next
        }
        return { value, next: at }
      }
      case 'array': {
        const value = []
        for (let index = 0; index < size; index++) {
          const entry = this.decode(at)
          value.push(entry.value)
          at = entry.next
        }
        return { value, next: at }
      }
      case 'boolean':
        return { value: size !== 0, next: at }
    }
    const end = at + size
    if (end > buffer.length) throw new MmdbError('Data runs past the end of the file.')
    switch (type) {
      case 'string':
        return { value: buffer.toString('utf8', at, end), next: end }
      case 'bytes':
        return { value: Uint8Array.from(buffer.subarray(at, end)), next: end }
      case 'double':
        if (size !== 8) throw new MmdbError('A double must be 8 bytes.')
        return { value: buffer.readDoubleBE(at), next: end }
      case 'float':
        if (size !== 4) throw new MmdbError('A float must be 4 bytes.')
        return { value: buffer.readFloatBE(at), next: end }
      case 'int32': {
        let value = 0
        for (let index = at; index < end; index++) value = (value << 8) | buffer[index]
        // Fewer than four bytes are a positive number; four are two's complement.
        return { value: size === 4 ? value | 0 : value, next: end }
      }
      case 'uint16':
      case 'uint32':
      case 'uint64':
      case 'uint128': {
        let value = 0n
        for (let index = at; index < end; index++) value = (value << 8n) | BigInt(buffer[index])
        return {
          value: value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value,
          next: end,
        }
      }
      case 'container':
      case 'end':
        return { value: null, next: end }
    }
    throw new MmdbError('Unknown data type.')
  }

  pointer(control, at) {
    const buffer = this.buffer
    const size = (control >> 3) & 0x3
    const top = control & 0x7
    if (size === 0) return { offset: (top << 8) | buffer[at], next: at + 1 }
    if (size === 1) return { offset: ((top << 16) | buffer.readUInt16BE(at)) + 2048, next: at + 2 }
    if (size === 2)
      return { offset: top * 0x1000000 + buffer.readUIntBE(at, 3) + 526336, next: at + 3 }
    return { offset: buffer.readUInt32BE(at), next: at + 4 }
  }
}

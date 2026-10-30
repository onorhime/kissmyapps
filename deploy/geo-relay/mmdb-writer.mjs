// Writes small MaxMind DB files for tests: a handful of networks and the place each is in,
// in the same layout as DB-IP's city database. Repeated values are written once and
// pointed to, as real databases do, so the reader's pointers are exercised too.

import { addressBytes } from './mmdb.mjs'

const MARKER = Buffer.from('abcdef4d61784d696e642e636f6d', 'hex')
const TYPE = { pointer: 1, string: 2, double: 3, bytes: 4, uint16: 5, uint32: 6, map: 7 }
const EXTENDED = { int32: 8, uint64: 9, uint128: 10, array: 11, boolean: 14, float: 15 }

/** A value written as a given MaxMind type, such as uint16 in the metadata. */
export const typed = (type, value) => ({ [TYPED]: type, value })
const TYPED = Symbol('typed')

/**
 * networks: [{ network: '81.2.69.0/24', data: {...} }]. IPv4 networks go under ::/96
 * in the IPv6 tree, as in DB-IP's files.
 */
export function buildMmdb({
  networks,
  recordSize = 24,
  databaseType = 'DBIP-City-Lite',
  buildEpoch = 1_761_955_200,
  languages = ['en'],
  description = { en: 'Test data' },
}) {
  const data = new Encoder(true)
  // A node is [left, right]; a side is a node index, { data: offset }, or null for nothing.
  const nodes = [[null, null]]
  for (const { network, data: value } of networks) {
    const [address, length] = network.split('/')
    const bytes = addressBytes(address)
    if (!bytes) throw new Error(`Not a network: ${network}`)
    const full = bytes.length === 4 ? new Uint8Array([...new Uint8Array(12), ...bytes]) : bytes
    const prefix = Number(length) + (bytes.length === 4 ? 96 : 0)
    const offset = data.record(value)
    let node = 0
    for (let depth = 0; depth < prefix; depth++) {
      const bit = (full[depth >> 3] >> (7 - (depth & 7))) & 1
      if (depth === prefix - 1) {
        nodes[node][bit] = { data: offset }
      } else {
        if (typeof nodes[node][bit] !== 'number') {
          nodes.push([null, null])
          nodes[node][bit] = nodes.length - 1
        }
        node = nodes[node][bit]
      }
    }
  }
  const nodeCount = nodes.length
  const nodeBytes = (recordSize * 2) / 8
  const tree = Buffer.alloc(nodeCount * nodeBytes)
  const value = (side) =>
    side === null ? nodeCount : typeof side === 'number' ? side : nodeCount + 16 + side.data
  nodes.forEach(([left, right], index) => {
    const at = index * nodeBytes
    const l = value(left)
    const r = value(right)
    if (recordSize === 24) {
      tree.writeUIntBE(l, at, 3)
      tree.writeUIntBE(r, at + 3, 3)
    } else if (recordSize === 28) {
      tree.writeUIntBE(l & 0xffffff, at, 3)
      tree[at + 3] = ((l >>> 24) << 4) | (r >>> 24)
      tree.writeUIntBE(r & 0xffffff, at + 4, 3)
    } else {
      tree.writeUInt32BE(l, at)
      tree.writeUInt32BE(r, at + 4)
    }
  })
  const metadata = new Encoder(false)
  metadata.write({
    binary_format_major_version: typed('uint16', 2),
    binary_format_minor_version: typed('uint16', 0),
    build_epoch: typed('uint64', BigInt(buildEpoch)),
    database_type: databaseType,
    description,
    ip_version: typed('uint16', 6),
    languages,
    node_count: typed('uint32', nodeCount),
    record_size: typed('uint16', recordSize),
  })
  return Buffer.concat([tree, Buffer.alloc(16), data.buffer(), MARKER, metadata.buffer()])
}

class Encoder {
  constructor(share) {
    this.parts = []
    this.length = 0
    this.seen = share ? new Map() : null
  }

  buffer() {
    return Buffer.concat(this.parts)
  }

  push(bytes) {
    this.parts.push(Buffer.from(bytes))
    this.length += bytes.length
  }

  /** A network's record: the same place written before is shared, not pointed to. */
  record(value) {
    const key = stableKey(value)
    if (this.seen.has(key)) return this.seen.get(key)
    return this.write(value)
  }

  /** Writes a value, or a pointer to the same value written before. Returns its offset. */
  write(value) {
    const key = this.seen && typeof value !== 'number' ? stableKey(value) : null
    if (key !== null && this.seen.has(key)) {
      const at = this.length
      this.pointer(this.seen.get(key))
      return at
    }
    const at = this.length
    this.encode(value)
    if (key !== null) this.seen.set(key, at)
    return at
  }

  head(type, size) {
    const extended = EXTENDED[type]
    const code = extended ?? TYPE[type]
    const bytes = []
    let sizeBits = size
    const extra = []
    if (size >= 65821) {
      sizeBits = 31
      const rest = size - 65821
      extra.push(rest >> 16, (rest >> 8) & 0xff, rest & 0xff)
    } else if (size >= 285) {
      sizeBits = 30
      const rest = size - 285
      extra.push(rest >> 8, rest & 0xff)
    } else if (size >= 29) {
      sizeBits = 29
      extra.push(size - 29)
    }
    bytes.push(((extended ? 0 : code) << 5) | sizeBits)
    if (extended) bytes.push(code - 7)
    this.push([...bytes, ...extra])
  }

  pointer(offset) {
    if (offset < 2048) this.push([(1 << 5) | (offset >> 8), offset & 0xff])
    else if (offset < 526336) {
      const v = offset - 2048
      this.push([(1 << 5) | (1 << 3) | (v >> 16), (v >> 8) & 0xff, v & 0xff])
    } else {
      const v = offset - 526336
      this.push([(1 << 5) | (2 << 3) | (v >> 24), (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff])
    }
  }

  unsigned(type, value) {
    let big = BigInt(value)
    const bytes = []
    while (big > 0n) {
      bytes.unshift(Number(big & 0xffn))
      big >>= 8n
    }
    this.head(type, bytes.length)
    this.push(bytes)
  }

  encode(value) {
    if (value && typeof value === 'object' && TYPED in value) {
      const type = value[TYPED]
      if (type.startsWith('uint')) return this.unsigned(type, value.value)
      if (type === 'float') {
        const bytes = Buffer.alloc(4)
        bytes.writeFloatBE(value.value)
        this.head('float', 4)
        return this.push(bytes)
      }
      throw new Error(`Cannot write ${type}`)
    }
    if (typeof value === 'string') {
      const bytes = Buffer.from(value, 'utf8')
      this.head('string', bytes.length)
      return this.push(bytes)
    }
    if (typeof value === 'boolean') return this.head('boolean', value ? 1 : 0)
    if (typeof value === 'bigint')
      return this.unsigned(value < 2n ** 64n ? 'uint64' : 'uint128', value)
    if (typeof value === 'number') {
      if (Number.isInteger(value) && value >= 0 && value < 2 ** 32)
        return this.unsigned('uint32', value)
      if (Number.isInteger(value) && value < 0 && value >= -(2 ** 31)) {
        const bytes = Buffer.alloc(4)
        bytes.writeInt32BE(value)
        this.head('int32', 4)
        return this.push(bytes)
      }
      const bytes = Buffer.alloc(8)
      bytes.writeDoubleBE(value)
      this.head('double', 8)
      return this.push(bytes)
    }
    if (value instanceof Uint8Array) {
      this.head('bytes', value.length)
      return this.push(value)
    }
    if (Array.isArray(value)) {
      this.head('array', value.length)
      for (const item of value) this.write(item)
      return
    }
    const entries = Object.entries(value)
    this.head('map', entries.length)
    for (const [key, item] of entries) {
      this.write(key)
      this.write(item)
    }
  }
}

function stableKey(value) {
  return JSON.stringify(value, (_, item) =>
    typeof item === 'bigint'
      ? `${item}n`
      : item && typeof item === 'object' && TYPED in item
        ? { type: item[TYPED], value: String(item.value) }
        : item,
  )
}

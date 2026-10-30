/** Small deterministic helpers so preview data is identical on every load. */

export function hashString(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function seededRandom(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** A stable number in [0, 1) for any combination of keys. */
export function noise(...keys: Array<string | number>): number {
  return seededRandom(hashString(keys.join('|')))()
}

export function pickWeighted<T>(items: readonly T[], weights: readonly number[], roll: number): T {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let target = roll * total
  for (let index = 0; index < items.length; index += 1) {
    target -= weights[index]
    if (target < 0) return items[index]
  }
  return items[items.length - 1]
}

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function randomToken(length: number, random: () => number): string {
  let token = ''
  for (let index = 0; index < length; index += 1) {
    token += alphabet[Math.floor(random() * alphabet.length)]
  }
  return token
}

/** Browser-strength randomness for generated keys; preview data uses seeded rolls. */
export function secureToken(length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

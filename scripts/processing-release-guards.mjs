// Supabase Management API exposes the bundle digest as ezbr_sha256, not sha256.
// Missing metadata must fail closed rather than compare undefined to undefined.
export function sameFunctionBundle(before, after) {
  return Boolean(
    before &&
    after &&
    before.slug === after.slug &&
    /^[a-f0-9]{64}$/.test(before.ezbr_sha256 ?? '') &&
    before.ezbr_sha256 === after.ezbr_sha256,
  )
}

export function priorFunctionBundlesUnchanged(before, after) {
  return (
    Array.isArray(before) &&
    before.length > 0 &&
    Array.isArray(after) &&
    new Set(before.map((f) => f.slug)).size === before.length &&
    new Set(after.map((f) => f.slug)).size === after.length &&
    before.every((f) =>
      sameFunctionBundle(
        f,
        after.find((x) => x.slug === f.slug),
      ),
    )
  )
}

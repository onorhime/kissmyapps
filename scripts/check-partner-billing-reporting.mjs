// Compatibility entry point for the former hosted billing regression check.
// It now runs the complete disposable native database suite, including the
// synthetic billing assertions. No linked Supabase credentials or providers
// are used. Hosted readiness must be checked separately using read-only queries.
if (process.argv.length !== 2) {
  throw new Error('This local-only regression check accepts no arguments or deployment mode')
}
await import('./test-database-native.mjs')

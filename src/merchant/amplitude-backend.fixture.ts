// What the Amplitude functions return to the console (Phase 8, piece D). The saved answer is the
// real capture of the database suite supabase/tests/database/92_analytics_destinations.sql
// (the line "capture analytics_destinations_get.saved"); the empty one is written by hand to the
// same shape. The readers (amplitude.backend.test.ts) and the Amplitude card
// (connections.tools.test.tsx) check these shapes. The key is never in an answer: only its
// last four.

export const amplitudeBackendFixture: Record<string, unknown> = {
  'analytics_destinations_get.saved': {
    destinations: [
      {
        region: 'us',
        status: 'active',
        provider: 'amplitude',
        sent_30d: 0,
        key_last4: 'beef',
        failed_30d: 0,
        last_error: null,
        last_sent_at: null,
      },
    ],
  },
  'analytics_destinations_get.none': { destinations: [] },
}

## D. Amplitude

A merchant pastes the API key of an Amplitude project on one KissMyApps analytics project
(console: Connections, Amplitude card, piece E). From then on every matched app install of an
identified person of that project is sent to that Amplitude project once, as two events in one
request:

- an `$identify` that sets the user properties `kma_source`, `kma_campaign`, `kma_method` and
  `kma_creator` (`$set`; `$unset` for those with no value: Amplitude applies user property
  operations only on `$identify`);
- the event `[KissMyApps] Install attributed` at the install's time, with the event properties
  `source`, `campaign`, `method`, `exact`, `platform` and `creator` (the creator's public name
  when a creator's link brought the install, otherwise null).

Sent: production installs that are matched (not organic, not rejected, with a source) of a
person with a user ID. An anonymous person's install is sent when the app identifies them; an
organic install that the minute tick matches at sign-in is sent then. Not sent: development
keys, organic and rejected installs, installs made before the key was saved, anything of a
project without a key. Amplitude receives the app's own user ID and nothing else about the
person.

Written and tested locally only (`92_analytics_destinations.sql`: saving with roles, the queue
fed by the real install, identify and tick functions, claim and finish, retry, failure, pause
on a refused key, removing; the worker's Deno tests with Amplitude stubbed). Nothing here has
called Amplitude or hosted Supabase.

### What ships

| Piece                                                                           | Where                                                           |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Destinations table, job queue, triggers, console and worker functions, schedule | `supabase/migrations/20261121103000_analytics_destinations.sql` |
| The worker that calls Amplitude's HTTP V2 API                                   | `supabase/functions/analytics-destinations-worker/`             |
| Its `verify_jwt = false` entry                                                  | `supabase/config.toml`                                          |

Amplitude: `POST https://api2.amplitude.com/2/httpapi` (US) or
`https://api.eu.amplitude.com/2/httpapi` (EU), a JSON body with the merchant's project key,
the events and `options.min_id_length = 1`, at most 10 events (5 installs) per request, the Free plan's limit
(https://amplitude.com/docs/apis/analytics/http-v2).

### What the migration does to existing data

- Two new tables, both closed to every API role (`analytics_destinations` holds the key;
  `analytics_destination_jobs` is the queue). No existing row changes.
- Triggers on `attribution_installs` (after insert; after an update of the match, verdict or
  person) and on `analytics_people` (after `user_id` goes from empty to set). Each is one
  lookup of the project's destination and does nothing for a project without one; an error in
  it is caught and reported as a warning, so it can never stop an install or an event.

### Order

1. Apply the migration (after the Phase 7 migrations and the Phase 8 base). Nothing is sent:
   no project has a key.
2. Set the function secrets (below). Leave `ANALYTICS_DESTINATIONS_ENABLED` unset.
3. Deploy the worker:

   ```sh
   supabase functions deploy analytics-destinations-worker --project-ref mmyruzjemjecqyivhrgr --no-verify-jwt
   ```

4. Store the scheduler value in Vault and install the schedule (below). It stays paused.
5. Set `ANALYTICS_DESTINATIONS_ENABLED=true`, then enable the schedule row.
6. Release the merchant console with the Amplitude card (piece E). Do the first live check.

### Function secrets

| Name                                      | Value                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ANALYTICS_DESTINATIONS_ENABLED`          | `true` to switch the worker on. Any other value: it answers `{"enabled": false}` and touches nothing.        |
| `ANALYTICS_DESTINATIONS_SCHEDULER_SECRET` | new. A random value of at least 32 characters, used only by the database schedule. Do not reuse another one. |
| `INTERNAL_WORKER_SECRET`                  | already set for the other workers. Lets a person call the worker by hand (header `x-kma-worker-secret`).     |

The worker needs no Amplitude credential of its own: each merchant's key is in the database
and is read only by the worker's claim. It is never logged, and never returned to the console
(which shows its last 4 characters).

### Schedule

1. Put the same value as `ANALYTICS_DESTINATIONS_SCHEDULER_SECRET` in Vault under the name
   `kma_analytics_destinations_scheduler`:

   ```sql
   select vault.create_secret('<the value>', 'kma_analytics_destinations_scheduler');
   ```

2. Check the project URL written in `kma_internal.tick_analytics_destination_schedule()`. It
   names the production project, like the other schedules. For any other project the function
   must be changed first.
3. Look in `cron.job` for the name `kma-analytics-destinations`. If it is absent, install it:

   ```sql
   select cron.schedule(
     'kma-analytics-destinations', '* * * * *',
     'select kma_internal.tick_analytics_destination_schedule();'
   );
   ```

4. When the worker is deployed and `ANALYTICS_DESTINATIONS_ENABLED` is `true`:

   ```sql
   update kma_internal.analytics_destination_schedule set enabled = true where singleton;
   ```

The tick returns `locked`, `paused`, `idle` (no job due, or only jobs of paused destinations),
`scheduler_value_missing` or `dispatched`. It calls the worker only when a job is due.

A job is retried after 1, 2, 4 ... minutes (at most 6 hours; 60 seconds when Amplitude
throttles, an hour for silenced devices) and fails after its 10th attempt. When Amplitude
answers that the key is invalid, the destination is paused (console status `paused`, last error
`invalid_key`) and its jobs wait without using attempts; saving a key again makes it active and
sends them. Events Amplitude refuses are sent one by one and the one at fault fails
(`invalid_event`).

To stop sending: set `enabled = false` on the schedule row (jobs keep waiting) or unset
`ANALYTICS_DESTINATIONS_ENABLED`. A merchant stops their own by removing the key, which drops
what waits for it.

### First live check

Use a project of your own with attribution on, a smart link and an Amplitude project of your
own (its API key: Amplitude, Settings, Projects, the project, General).

1. In the console's Amplitude card, paste the key and choose the region. Expect status
   "active", the key's last 4 characters and nothing sent.
2. On a real phone, open the smart link, install the app (SDK 1.1), and sign in so the app
   sends a user ID. Within two minutes expect in Amplitude, under that user ID, the event
   `[KissMyApps] Install attributed` with the source and method, and the user properties
   `kma_source`, `kma_method` (and `kma_campaign`, `kma_creator` when set).
3. Check the rows:

   ```sql
   select d.status, d.last_sent_at, d.last_error, d.sent_total, d.failed_total
   from public.analytics_destinations d;
   select status, attempts, last_error, finished_at
   from public.analytics_destination_jobs order by created_at desc limit 5;
   ```

   Expect `active`, one job `sent` with 1 attempt.

4. Change one character of the key in the card and install on a second phone: expect status
   "paused" with the last error `invalid_key`, and the job waiting. Paste the right key: the
   job is sent within a minute.
5. Remove the key: the card shows nothing set and the queue is empty for that project.

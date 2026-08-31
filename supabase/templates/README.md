# Supabase Auth email template sources

`confirmation.html` is the source for the hosted Supabase **Confirm signup** email. It combines the required email-confirmation action with the welcome message; it is not a separate marketing email.

The template expects signup metadata to provide `full_name`, with a generic greeting fallback. Its confirmation link intentionally uses Supabase's `SiteURL` and `TokenHash` variables. Hosted Supabase projects do not read this source file automatically, so applying it requires an explicit, reviewed dashboard or Management API update. Keep external-provider click tracking disabled because rewriting an authentication link can prevent confirmation.

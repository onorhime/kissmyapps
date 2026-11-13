-- Attribution Phase 3, piece A: revenue and exchange rates. The base migration's helpers first;
-- piece A adds the revenue intake, the store revenue call, the rates call and the console.
begin;
set local time zone 'UTC';
create temporary table revenue_assertions(label text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Attribution revenue assertion failed: %', label; end if;
  insert into revenue_assertions values (label);
end $$;

-- Base helpers -----------------------------------------------------------------------------
select pg_temp.check(kma_internal.currency_exponent('USD') = 2 and kma_internal.currency_exponent('JPY') = 0
  and kma_internal.currency_exponent('KWD') = 3 and kma_internal.currency_exponent('NGN') = 2,
  'currency decimals follow ISO 4217');
select pg_temp.check(kma_internal.attribution_source_family('Facebook') = 'meta'
  and kma_internal.attribution_source_family('ig') = 'meta'
  and kma_internal.attribution_source_family('tt') = 'tiktok'
  and kma_internal.attribution_source_family('adwords') = 'google_ads'
  and kma_internal.attribution_source_family(' Newsletter ') = 'newsletter'
  and kma_internal.attribution_source_family(null) is null,
  'source names fold into their ad platform');

insert into public.attribution_fx_rates(currency, day, per_eur) values
  ('USD', '2026-11-02', 1.10), ('USD', '2026-11-03', 1.12), ('GBP', '2026-11-03', 0.88), ('JPY', '2026-11-03', 165);
select pg_temp.check(kma_internal.attribution_fx_rate('USD', 'USD', '2026-11-03') = 1
  and kma_internal.attribution_fx_rate('XYZ', 'XYZ', '2026-11-03') = 1, 'a currency is worth itself');
select pg_temp.check(kma_internal.attribution_fx_rate('EUR', 'USD', '2026-11-03') = 1.12
  and kma_internal.attribution_fx_rate('USD', 'EUR', '2026-11-02') = 1 / 1.10::numeric,
  'euro rates are the ECB rate');
select pg_temp.check(round(kma_internal.attribution_fx_rate('GBP', 'USD', '2026-11-03'), 6) = round(1.12 / 0.88, 6),
  'a cross rate goes through the euro');
select pg_temp.check(kma_internal.attribution_fx_rate('EUR', 'USD', '2026-11-09') = 1.12
  and kma_internal.attribution_fx_rate('EUR', 'USD', '2026-10-01') = 1.10,
  'a day without a rate uses the latest before it, else the earliest after it');
select pg_temp.check(kma_internal.attribution_fx_rate('NGN', 'USD', '2026-11-03') is null,
  'a currency the ECB does not publish has no rate');

select 'ok ' || count(*) || ' attribution revenue assertions' from revenue_assertions;
rollback;

// The ECB files as saved samples (laid out by deno fmt): eurofxref-daily.sample.xml
// is the daily file (one day, attributes in single quotes),
// eurofxref-hist.sample.xml a history file (several days, double quotes). Their
// rates are illustrative, not the ECB's published figures. No network. The
// history files' own layout, all on one line, is read in index_test.ts.
import { assertEquals } from "@std/assert";
import { ECB_URLS, isDay, parseEcbXml } from "./ecb.ts";

const sample = (name: string) =>
  Deno.readTextFile(new URL(`./${name}`, import.meta.url));

Deno.test("the daily file is one day of rates in the file's order", async () => {
  const parsed = parseEcbXml(await sample("eurofxref-daily.sample.xml"));
  assertEquals(parsed.days, 1);
  assertEquals(parsed.skipped, 0);
  assertEquals(parsed.rates.length, 10);
  assertEquals(parsed.rates.slice(0, 3), [
    { day: "2026-11-12", currency: "USD", per_eur: 1.1582 },
    { day: "2026-11-12", currency: "JPY", per_eur: 178.46 },
    { day: "2026-11-12", currency: "CZK", per_eur: 24.215 },
  ]);
  assertEquals(
    parsed.rates.find((rate) => rate.currency === "GBP")?.per_eur,
    0.8821,
  );
  assertEquals(parsed.rates.map((rate) => rate.currency).at(-1), "KRW");
});

Deno.test("a history file gives each currency under its own day", async () => {
  const parsed = parseEcbXml(await sample("eurofxref-hist.sample.xml"));
  assertEquals(parsed.days, 3);
  assertEquals(parsed.skipped, 0);
  assertEquals(parsed.rates.length, 12);
  assertEquals(
    parsed.rates.filter((rate) => rate.currency === "USD"),
    [
      { day: "2026-11-12", currency: "USD", per_eur: 1.1582 },
      { day: "2026-11-11", currency: "USD", per_eur: 1.1567 },
      { day: "2026-11-10", currency: "USD", per_eur: 1.1549 },
    ],
  );
  assertEquals(
    parsed.rates.filter((rate) => rate.day === "2026-11-10").map((rate) =>
      rate.currency
    ),
    ["USD", "JPY", "GBP", "CHF"],
  );
});

Deno.test("cubes that cannot be read are skipped and counted, comments ignored", () => {
  const parsed = parseEcbXml(`<?xml version="1.0"?>
<!-- <Cube time="2026-01-01"><Cube currency="ZZZ" rate="9"/></Cube> -->
<Cube>
  <Cube currency="USD" rate="1.1"/>
  <Cube time="2026-11-31"><Cube currency="USD" rate="1.1"/></Cube>
  <Cube time = "2026-11-12" >
    <Cube rate="1.2" currency="USD" />
    <Cube currency="usd" rate="1.2"/>
    <Cube currency="EUR" rate="1"/>
    <Cube currency="GBP" rate="0"/>
    <Cube currency="CHF" rate="-0.9"/>
    <Cube currency="SEK" rate="1e3"/>
    <Cube currency="NOK" rate="abc"/>
    <Cube currency="DKK"/>
    <Cube currency='PLN' rate='4.25'/>
  </Cube>
</Cube>`);
  assertEquals(parsed.rates, [
    { day: "2026-11-12", currency: "USD", per_eur: 1.2 },
    { day: "2026-11-12", currency: "PLN", per_eur: 4.25 },
  ]);
  // A rate before any day, one under an impossible day, and seven bad cubes.
  assertEquals(parsed.skipped, 9);
  assertEquals(parsed.days, 1);
});

Deno.test("an empty or foreign document has no rates", () => {
  for (const text of ["", "<html><body>Not found</body></html>", "<Cube/>"]) {
    assertEquals(parseEcbXml(text), { rates: [], days: 0, skipped: 0 });
  }
});

Deno.test("days are real calendar days", () => {
  assertEquals(
    ["2026-11-12", "2024-02-29", "2026-02-29", "2026-13-01", "26-11-12", ""]
      .map(isDay),
    [true, true, false, false, false, false],
  );
});

Deno.test("the three files are the ECB's", () => {
  assertEquals(ECB_URLS, {
    daily: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
    "90d": "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml",
    all: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml",
  });
});

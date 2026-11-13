// deno-lint-ignore-file require-await -- Fake adapters keep production async boundaries.
import { assert, assertEquals } from "@std/assert";
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import {
  CHUNK_SIZE,
  createAttributionFxWorker,
  type FxWorkerDependencies,
  type FxWorkerLogEntry,
  handleAttributionFxWorker,
  MAXIMUM_XML_BYTES,
} from "./index.ts";
import type { EcbRate } from "./ecb.ts";
import {
  type FxStore,
  MAXIMUM_RATES_PER_CALL,
  parseStored,
  storeInput,
} from "./store.ts";

type Json = Record<string, unknown>;

const NOW = Date.parse("2026-11-13T16:30:00Z");
const URL_ = "https://project.example.invalid/attribution-fx-worker";
const DAILY = await Deno.readTextFile(
  new URL("./eurofxref-daily.sample.xml", import.meta.url),
);
const HISTORY = await Deno.readTextFile(
  new URL("./eurofxref-hist.sample.xml", import.meta.url),
);

/** The ECB's three files, served from the samples; anything else fails the test. */
class FakeEcb {
  readonly asked: string[] = [];
  answer: (url: string) => Response | Promise<Response> = (url) =>
    new Response(url.endsWith("eurofxref-daily.xml") ? DAILY : HISTORY, {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });

  readonly fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (
      (init?.method ?? "GET") !== "GET" ||
      !url.startsWith("https://www.ecb.europa.eu/stats/eurofxref/")
    ) throw new Error("the worker only reads the ECB's files");
    this.asked.push(url);
    return await this.answer(url);
  };
}

interface Fixture {
  ecb: FakeEcb;
  saved: Json[];
  logs: FxWorkerLogEntry[];
  run: (body?: string) => Promise<{ status: number; body: Json }>;
}

function fixture(
  options: {
    save?: (input: Json) => unknown;
    deps?: Partial<FxWorkerDependencies>;
  } = {},
): Fixture {
  const ecb = new FakeEcb();
  const saved: Json[] = [];
  const logs: FxWorkerLogEntry[] = [];
  // The real input and answer shapes, around a fake database.
  const store: FxStore = {
    save: async (rates: EcbRate[]) => {
      const input = storeInput(rates);
      saved.push(input);
      const answer = options.save
        ? options.save(input)
        : { stored: (input.rates as Json[]).length, latest_day: "2026-11-12" };
      return parseStored(answer);
    },
  };
  const handler = createAttributionFxWorker({
    enabled: () => true,
    authenticate: () => {},
    store: () => store,
    fetcher: ecb.fetcher,
    now: () => NOW,
    log: (entry) => logs.push(entry),
    ...options.deps,
  });
  return {
    ecb,
    saved,
    logs,
    run: async (body?: string) => {
      const response = await handler(
        new Request(URL_, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      );
      return { status: response.status, body: await response.json() };
    },
  };
}

Deno.test("only the exact value true turns the worker on; off, it reads nothing", async () => {
  for (const value of [undefined, "", "TRUE", "1", " true"]) {
    const f = fixture({ deps: { enabled: () => value === "true" } });
    const { status, body } = await f.run("{}");
    assertEquals(status, 200);
    assertEquals(body.enabled, false);
    assertEquals(f.ecb.asked, []);
    assertEquals(f.saved, []);
  }
  const name = "ATTRIBUTION_FX_ENABLED";
  const previous = Deno.env.get(name);
  try {
    for (const value of ["", "false", "TRUE"]) {
      Deno.env.set(name, value);
      const ecb = new FakeEcb();
      // The shipped switch, with everything else faked.
      const handler = createAttributionFxWorker({
        authenticate: () => {},
        fetcher: ecb.fetcher,
        log: () => {},
      });
      const response = await handler(new Request(URL_, { method: "POST" }));
      assertEquals((await response.json()).enabled, false);
      assertEquals(ecb.asked, []);
    }
  } finally {
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  }
});

Deno.test("the schedule and a person each need their own credential", async () => {
  const names = ["ATTRIBUTION_FX_SCHEDULER_SECRET", "INTERNAL_WORKER_SECRET"];
  const previous = names.map((name) => Deno.env.get(name));
  const scheduler = "scheduler-fixture-00000000000000000000000";
  const internal = "internal-fixture-000000000000000000000000";
  Deno.env.set(names[0], scheduler);
  Deno.env.set(names[1], internal);
  const handler = createAttributionFxWorker({
    enabled: () => false,
    log: () => {},
  });
  const call = async (headers: Record<string, string>, method = "POST") => {
    const response = await handler(new Request(URL_, { method, headers }));
    await response.body?.cancel();
    return response.status;
  };
  try {
    assertEquals(await call({ "x-kma-scheduler-secret": scheduler }), 200);
    assertEquals(await call({ "x-kma-worker-secret": internal }), 200);
    assertEquals(await call({ "x-kma-scheduler-secret": internal }), 401);
    assertEquals(await call({ "x-kma-worker-secret": scheduler }), 401);
    assertEquals(await call({}), 401);
    assertEquals(
      await call({
        "x-kma-scheduler-secret": scheduler,
        origin: "https://evil.example",
      }),
      401,
    );
    assertEquals(
      await call({ "x-kma-scheduler-secret": scheduler }, "GET"),
      405,
    );
    Deno.env.set(names[0], "short");
    assertEquals(await call({ "x-kma-scheduler-secret": "short" }), 401);
    const closed = await handleAttributionFxWorker(
      new Request(URL_, { method: "POST" }),
    );
    assertEquals(closed.status, 401);
    await closed.body?.cancel();
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) Deno.env.delete(name);
      else Deno.env.set(name, previous[index]!);
    });
  }
});

Deno.test("by default the last 90 days are read and stored in one call", async () => {
  for (const body of [undefined, "", "{}", '{"range":"90d"}']) {
    const f = fixture();
    const { status, body: answer } = await f.run(body);
    assertEquals(status, 200);
    assertEquals(f.ecb.asked, [
      "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml",
    ]);
    assertEquals(f.saved.length, 1);
    const rates = f.saved[0].rates as Json[];
    assertEquals(rates.length, 12);
    assertEquals(rates[0], {
      day: "2026-11-12",
      currency: "USD",
      per_eur: 1.1582,
    });
    assertEquals(rates.at(-1), {
      day: "2026-11-10",
      currency: "CHF",
      per_eur: 0.9312,
    });
    assertEquals(answer.status, "processed");
    assertEquals(answer.range, "90d");
    assertEquals(
      [answer.days, answer.rates, answer.stored, answer.skipped],
      [3, 12, 12, 0],
    );
    assertEquals(answer.latest_day, "2026-11-12");
    assertEquals(f.logs, [{
      level: "info",
      worker: "attribution-fx-worker",
      outcome: "processed",
      request_id: answer.request_id as string,
      range: "90d",
      counts: { days: 3, rates: 12, stored: 12, skipped: 0 },
    }]);
  }
});

Deno.test("daily and all pick the other two files", async () => {
  const daily = fixture();
  const one = await daily.run('{"range":"daily"}');
  assertEquals(daily.ecb.asked, [
    "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
  ]);
  assertEquals([one.body.range, one.body.days, one.body.rates], [
    "daily",
    1,
    10,
  ]);
  const all = fixture();
  const every = await all.run('{"range":"all"}');
  assertEquals(all.ecb.asked, [
    "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml",
  ]);
  assertEquals(every.body.range, "all");
});

Deno.test("a body that is not a range is refused before the ECB is asked", async () => {
  for (
    const body of [
      '{"range":"7d"}',
      '{"range":90}',
      "[]",
      "not json",
      '"daily"',
      JSON.stringify({ range: "daily", pad: "x".repeat(2000) }),
    ]
  ) {
    const f = fixture();
    const { status, body: answer } = await f.run(body);
    assert(status === 400 || status === 413, body.slice(0, 30));
    assert(
      ["invalid_range", "invalid_body", "payload_too_large"].includes(
        answer.error as string,
      ),
    );
    assertEquals(f.ecb.asked, []);
    assertEquals(f.logs[0].level, "warning");
  }
});

Deno.test("the whole history goes to the database in chunks", async () => {
  // Rates for 16000 currency days, one per day from 1999 on in four currencies.
  const days = Array.from(
    { length: 4_000 },
    (_, i) =>
      new Date(Date.UTC(1999, 0, 4) + i * 86_400_000).toISOString().slice(
        0,
        10,
      ),
  );
  const xml = `<Cube>${
    days.map((day) =>
      `<Cube time="${day}"><Cube currency="USD" rate="1.1"/><Cube currency="JPY" rate="130"/><Cube currency="GBP" rate="0.7"/><Cube currency="CHF" rate="1.6"/></Cube>`
    ).join("")
  }</Cube>`;
  let calls = 0;
  const f = fixture({
    save: (input) => {
      calls += 1;
      return {
        stored: (input.rates as Json[]).length,
        latest_day: calls === 4 ? "2009-12-01" : "2005-01-01",
      };
    },
  });
  f.ecb.answer = () => new Response(xml, { status: 200 });
  const { status, body } = await f.run('{"range":"all"}');
  assertEquals(status, 200);
  assert(CHUNK_SIZE <= MAXIMUM_RATES_PER_CALL);
  assertEquals(
    f.saved.map((input) => (input.rates as Json[]).length),
    [5_000, 5_000, 5_000, 1_000],
  );
  assertEquals([body.days, body.rates, body.stored], [4_000, 16_000, 16_000]);
  assertEquals(body.latest_day, "2009-12-01");
});

Deno.test("days the database would refuse are left out and counted as skipped", async () => {
  const f = fixture();
  f.ecb.answer = () =>
    new Response(
      `<Cube><Cube time="1998-12-31"><Cube currency="USD" rate="1.2"/></Cube>
      <Cube time="2026-11-14"><Cube currency="USD" rate="1.2"/></Cube>
      <Cube time="2026-11-15"><Cube currency="USD" rate="1.2"/></Cube>
      <Cube time="2026-11-13"><Cube currency="usd" rate="1.2"/><Cube currency="USD" rate="1.2"/></Cube></Cube>`,
      { status: 200 },
    );
  const { body } = await f.run();
  assertEquals(
    (f.saved[0].rates as Json[]).map((rate) => rate.day),
    ["2026-11-14", "2026-11-13"],
  );
  assertEquals([body.rates, body.skipped], [2, 3]);
});

Deno.test("when the ECB cannot be read the run fails with a 502 and stores nothing", async () => {
  const cases: [
    () => Response | Promise<Response>,
    string,
    number | undefined,
  ][] = [
    [
      () => {
        throw new TypeError("connection reset");
      },
      "ecb_unreachable",
      undefined,
    ],
    [() => new Response("busy", { status: 503 }), "ecb_unavailable", 503],
    [() => new Response("moved", { status: 404 }), "ecb_unavailable", 404],
    [
      () => new Response("<html>maintenance</html>", { status: 200 }),
      "ecb_no_rates",
      undefined,
    ],
    [
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(4 * 1024 * 1024));
            },
          }),
          { status: 200 },
        ),
      "ecb_too_large",
      undefined,
    ],
    [
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<Cube>"));
              controller.error(new TypeError("cut off"));
            },
          }),
          { status: 200 },
        ),
      "ecb_unreachable",
      undefined,
    ],
  ];
  assert(MAXIMUM_XML_BYTES > 4 * 1024 * 1024);
  for (const [answer, code, upstream] of cases) {
    const f = fixture();
    f.ecb.answer = answer;
    const { status, body } = await f.run();
    assertEquals(status, 502, code);
    assertEquals(body.error, code);
    assertEquals(f.saved, []);
    assertEquals(f.logs.length, 1);
    assertEquals(f.logs[0].level, "error");
    assertEquals(f.logs[0].outcome, code);
    assertEquals(f.logs[0].range, "90d");
    assertEquals(f.logs[0].upstream_status, upstream);
    assert(!JSON.stringify(f.logs).includes("maintenance"));
  }
});

Deno.test("a database refusal or an unexpected answer fails the run closed", async () => {
  for (
    const [save, code] of [
      [() => {
        throw new DatabaseBoundaryError("22023");
      }, "database_boundary_error"],
      [() => ({ stored: -1, latest_day: null }), "database_boundary_error"],
      [() => ({ stored: 1, latest_day: "12 Nov" }), "database_boundary_error"],
      [() => null, "database_boundary_error"],
    ] as const
  ) {
    const f = fixture({ save });
    const { status, body } = await f.run();
    assertEquals(status, 503);
    assertEquals(body.error, code);
    assertEquals(f.logs[0].outcome, code);
    assertEquals(f.logs[0].level, "error");
  }
  assertEquals(parseStored({ stored: 0, latest_day: null }), {
    stored: 0,
    latestDay: null,
  });
});

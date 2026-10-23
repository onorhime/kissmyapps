// deno-lint-ignore-file require-await -- Fake adapters preserve the asynchronous production boundary.
import { createCreatorPayoutWorker } from "./index.ts";
import { ConnectProvider } from "../creator-connect/provider.ts";
import {
  assertEquals,
  assertRejects,
  config,
  creator,
  FakeStripe,
  job,
  NOW,
  readyAccount,
} from "../creator-connect/test-support.ts";
import { DatabaseBoundaryError, RequestError } from "../_shared/errors.ts";
const request = () =>
  new Request("https://local.invalid/worker", { method: "POST" });
function fixture() {
  const fake = new FakeStripe(), finished: Array<Record<string, unknown>> = [];
  const handler = createCreatorPayoutWorker({
    authenticate: () => {},
    bindings: () => new Map([["fixture", config]]),
    processCommissions: async () => {},
    beginAttempt: async (j) => ({
      ...j,
      first_attempt_at: j.first_attempt_at ?? new Date(NOW).toISOString(),
    }),
    reconciliationJobs: async () => [],
    claim: async () => [{ ...job }],
    account: async () => creator,
    finish: async (input) => {
      finished.push(input);
    },
    provider: (c) => new ConnectProvider(c, fake.fetch, () => NOW),
  });
  return { fake, finished, handler };
}
Deno.test("worker disabled and unauthorized paths make no provider calls", async () => {
  const handler = createCreatorPayoutWorker({
    authenticate: () => {},
    bindings: () => new Map(),
    processCommissions: async () => {},
    beginAttempt: async (j) => ({
      ...j,
      first_attempt_at: j.first_attempt_at ?? new Date(NOW).toISOString(),
    }),
    reconciliationJobs: async () => [],
  });
  assertEquals(await (await handler(request())).json(), {
    enabled: false,
    processed: 0,
  });
  const denied = createCreatorPayoutWorker({
    authenticate: () => {
      throw new RequestError(401, "unauthorized", "Denied");
    },
    bindings: () => {
      throw new Error("must not run");
    },
  });
  assertEquals((await denied(request())).status, 401);
});
Deno.test("worker transfers only a scoped approved job to a freshly verified account", async () => {
  const f = fixture();
  assertEquals((await f.handler(request())).status, 200);
  assertEquals(f.finished[0].status, "succeeded");
  const post = f.fake.calls.find((c) =>
    c.path === "transfers" && c.method === "POST"
  )!;
  assertEquals(post.body.get("amount"), "2000");
  assertEquals(post.body.get("destination"), creator.connect_account_id);
  assertEquals(post.headers.get("Idempotency-Key"), job.idempotency_key);
  assertEquals(post.body.has("source_transaction"), false);
});
Deno.test("unverified account blocks transfer without spending", async () => {
  const f = fixture();
  f.fake.accounts.set(creator.connect_account_id, {
    ...readyAccount(),
    payouts_enabled: false,
  });
  await f.handler(request());
  assertEquals(f.finished[0].status, "retry");
  assertEquals(f.fake.calls.filter((c) => c.method === "POST").length, 0);
});
Deno.test("read-only preflight delays do not start the 23 hour mutation window", async () => {
  const fake = new FakeStripe(), finished: Array<Record<string, unknown>> = [];
  let now = NOW, marks = 0, firstAttempt: string | null = null;
  const handler = createCreatorPayoutWorker({
    authenticate: () => {},
    bindings: () => new Map([["fixture", config]]),
    processCommissions: async () => {},
    reconciliationJobs: async () => [],
    claim: async () => [{ ...job, first_attempt_at: firstAttempt }],
    account: async () => creator,
    beginAttempt: async (current) => {
      marks++;
      firstAttempt ??= new Date(now).toISOString();
      return { ...current, first_attempt_at: firstAttempt };
    },
    finish: async (input) => {
      finished.push(input);
    },
    provider: (c) => new ConnectProvider(c, fake.fetch, () => now),
  });
  fake.accounts.get(creator.connect_account_id)!.payouts_enabled = false;
  await handler(request());
  now += 48 * 3600_000;
  await handler(request());
  assertEquals(marks, 0);
  assertEquals(firstAttempt, null);
  assertEquals(fake.calls.filter((call) => call.method === "POST").length, 0);
  fake.accounts.get(creator.connect_account_id)!.payouts_enabled = true;
  await handler(request());
  assertEquals(finished.map((entry) => entry.status), [
    "retry",
    "retry",
    "succeeded",
  ]);
  assertEquals(marks, 1);
  assertEquals(firstAttempt, new Date(now).toISOString());
  assertEquals(fake.calls.filter((call) => call.method === "POST").length, 1);
});
Deno.test("provider requires the same live lease and frozen job immediately before mutation", async () => {
  for (const change of ["denied", "identity", "clock"] as const) {
    const fake = new FakeStripe(),
      provider = new ConnectProvider(config, fake.fetch, () => NOW);
    await assertRejects(() =>
      provider.execute({ ...job, first_attempt_at: null }, true, async () => {
        assertEquals(
          fake.calls.some((call) =>
            call.path.startsWith("transfers?") && call.method === "GET"
          ),
          true,
        );
        if (change === "denied") throw new DatabaseBoundaryError();
        return {
          ...job,
          ...(change === "identity" ? { amount_minor: 2001 } : {
            first_attempt_at: new Date(NOW - 24 * 3600_000).toISOString(),
          }),
        };
      })
    );
    assertEquals(fake.calls.filter((call) => call.method === "POST").length, 0);
  }
});
Deno.test("existing receipts and expired uncertain attempts never start a new mutation clock", async () => {
  const fake = new FakeStripe(),
    provider = new ConnectProvider(config, fake.fetch, () => NOW);
  const receipt = await provider.execute(job);
  let marks = 0;
  const marker = async () => {
    marks++;
    return job;
  };
  const expired = {
    ...job,
    first_attempt_at: new Date(NOW - 25 * 3600_000).toISOString(),
  };
  assertEquals(
    (await provider.execute(expired, true, marker)).provider_id,
    receipt.provider_id,
  );
  fake.transfers.clear();
  await assertRejects(() => provider.execute(expired, true, marker));
  await assertRejects(() =>
    provider.execute({ ...job, first_attempt_at: null }, false, marker)
  );
  assertEquals(marks, 0);
  assertEquals(fake.calls.filter((call) => call.method === "POST").length, 1);
});
Deno.test("unsupported country or missing same-currency funding route blocks transfer without spending", async () => {
  for (
    const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.fake.accounts.get(creator.connect_account_id)!.country = "NG";
      },
      (f: ReturnType<typeof fixture>) => {
        f.fake.balanceCurrencies = ["GBP"];
      },
      (f: ReturnType<typeof fixture>) => {
        const account = f.fake.accounts.get(creator.connect_account_id)!;
        account.default_currency = "gbp";
        account.external_accounts = { data: [], has_more: false };
      },
    ]
  ) {
    const f = fixture();
    mutate(f);
    await f.handler(request());
    assertEquals(f.finished[0].status, "retry");
    assertEquals(f.finished[0].safe_error, "transfer_currency_unavailable");
    assertEquals(
      f.fake.calls.filter((call) => call.method === "POST").length,
      0,
    );
  }
});
Deno.test("provider supported additional currencies become available without a hardcoded currency allowlist", async () => {
  const fake = new FakeStripe();
  fake.balanceCurrencies.push("CAD");
  const account = {
    ...readyAccount(),
    country: "CA",
    default_currency: "cad",
    external_accounts: { data: [], has_more: false },
  };
  const provider = new ConnectProvider(config, fake.fetch, () => NOW);
  await provider.verifyPlatform();
  assertEquals(await provider.transferCurrencies(account), ["CAD"]);
  await provider.assertTransferCurrency({ ...job, currency: "CAD" }, account);
  assertEquals(fake.calls.filter((call) => call.method === "POST").length, 0);
});
Deno.test("Stripe ISK and UGX transfer precision is checked without treating HUF transfers as bank payouts", async () => {
  const fake = new FakeStripe();
  fake.balanceCurrencies = ["ISK", "UGX", "HUF"];
  fake.countrySpecs.find((spec) => spec.id === "US")!
    .supported_bank_account_currencies = {
      isk: ["IS"],
      ugx: ["UG"],
      huf: ["HU"],
    };
  const account = {
    ...readyAccount(),
    default_currency: "isk",
    external_accounts: {
      data: [{ object: "bank_account", currency: "ugx", status: "verified" }, {
        object: "bank_account",
        currency: "huf",
        status: "verified",
      }],
      has_more: false,
    },
  };
  const provider = new ConnectProvider(config, fake.fetch, () => NOW);
  for (const currency of ["ISK", "UGX"]) {
    await assertRejects(() =>
      provider.assertTransferCurrency(
        { ...job, currency, amount_minor: 501 },
        account,
      )
    );
    await provider.assertTransferCurrency({
      ...job,
      currency,
      amount_minor: 500,
    }, account);
  }
  await provider.assertTransferCurrency({
    ...job,
    currency: "HUF",
    amount_minor: 501,
  }, account);
});
Deno.test("ambiguous transfer retries reconcile the existing object without a second mutation", async () => {
  const f = fixture();
  f.fake.ambiguousNextTransfer = true;
  await f.handler(request());
  assertEquals(f.finished[0].status, "retry");
  await f.handler(request());
  assertEquals(f.finished[1].status, "succeeded");
  assertEquals(
    f.fake.calls.filter((c) => c.path === "transfers" && c.method === "POST")
      .length,
    1,
  );
  assertEquals(f.fake.transfers.size, 1);
});
Deno.test("lost DB receipt is recovered after lease retry without duplicate money movement", async () => {
  const fake = new FakeStripe();
  let attempts = 0;
  const handler = createCreatorPayoutWorker({
    authenticate: () => {},
    bindings: () => new Map([["fixture", config]]),
    processCommissions: async () => {},
    beginAttempt: async (j) => ({
      ...j,
      first_attempt_at: j.first_attempt_at ?? new Date(NOW).toISOString(),
    }),
    reconciliationJobs: async () => [],
    claim: async () => [job],
    account: async () => creator,
    finish: async () => {
      if (attempts++ === 0) throw new DatabaseBoundaryError();
    },
    provider: (c) => new ConnectProvider(c, fake.fetch, () => NOW),
  });
  assertEquals((await handler(request())).status, 503);
  assertEquals((await handler(request())).status, 200);
  assertEquals(
    fake.calls.filter((c) => c.path === "transfers" && c.method === "POST")
      .length,
    1,
  );
});
Deno.test("refund reversal is separately idempotent and never invokes bank payouts", async () => {
  const fake = new FakeStripe(),
    provider = new ConnectProvider(config, fake.fetch, () => NOW);
  const transfer = await provider.execute(job);
  const reverse = {
    ...job,
    id: "55555555-5555-4555-8555-555555555555",
    kind: "reversal" as const,
    amount_minor: 500,
    transfer_id: transfer.provider_id,
    idempotency_key: "reverse-fixture",
  };
  const first = await provider.execute(reverse),
    second = await provider.execute(reverse);
  assertEquals(second.provider_id, first.provider_id);
  assertEquals(second.reconciled, true);
  assertEquals(fake.transfers.get(transfer.provider_id)!.amount_reversed, 500);
  assertEquals(
    fake.calls.filter((c) => c.path.includes("payouts") && c.method === "POST")
      .length,
    0,
  );
});
Deno.test("wrong mode/destination and expired ambiguity cannot produce a transfer", async () => {
  const fake = new FakeStripe(),
    provider = new ConnectProvider(config, fake.fetch, () => NOW);
  await assertRejects(() => provider.execute({ ...job, livemode: true }));
  await assertRejects(() =>
    provider.execute({ ...job, platform_account_id: "acct_other" })
  );
  await assertRejects(() =>
    provider.execute({
      ...job,
      first_attempt_at: new Date(NOW - 24 * 3600_000).toISOString(),
    })
  );
  assertEquals(fake.calls.filter((c) => c.method === "POST").length, 0);
});
Deno.test("insufficient funding remains retryable with the same job identity", async () => {
  const fake = new FakeStripe(), finished: Array<Record<string, unknown>> = [];
  const handler = createCreatorPayoutWorker({
    authenticate: () => {},
    bindings: () => new Map([["fixture", config]]),
    processCommissions: async () => {},
    beginAttempt: async (j) => ({
      ...j,
      first_attempt_at: j.first_attempt_at ?? new Date(NOW).toISOString(),
    }),
    reconciliationJobs: async () => [],
    claim: async () => [job],
    account: async () => creator,
    finish: async (i) => {
      finished.push(i);
    },
    provider: (c) =>
      new ConnectProvider(c, async (input, init) => {
        const url = String(input);
        if (url.endsWith("/transfers") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              error: {
                code: "balance_insufficient",
                message: "private provider detail",
              },
            }),
            { status: 402 },
          );
        }
        return await fake.fetch(input, init);
      }, () => NOW),
  });
  assertEquals((await handler(request())).status, 200);
  assertEquals(finished[0].status, "retry");
  assertEquals(finished[0].id, job.id);
  assertEquals(
    finished[0].safe_error,
    "provider_balance_or_account_unavailable",
  );
});
Deno.test("expired transfer and reversal receipts recover read-only while movements are disabled", async () => {
  const fake = new FakeStripe(),
    provider = new ConnectProvider(config, fake.fetch, () => NOW);
  const transfer = await provider.execute(job);
  const reversal = {
    ...job,
    id: "77777777-7777-4777-8777-777777777777",
    kind: "reversal" as const,
    amount_minor: 500,
    transfer_id: transfer.provider_id,
    idempotency_key: "reversal-recovery",
  };
  await provider.execute(reversal);
  const recovered: string[] = [];
  const before = fake.calls.filter((c) => c.method === "POST").length;
  const handler = createCreatorPayoutWorker({
    authenticate: () => {},
    bindings: () =>
      new Map([["fixture", { ...config, transfersEnabled: false }]]),
    processCommissions: async () => {},
    beginAttempt: async (j) => ({
      ...j,
      first_attempt_at: j.first_attempt_at ?? new Date(NOW).toISOString(),
    }),
    reconciliationJobs: async () =>
      [job, reversal].map((j) => ({
        ...j,
        first_attempt_at: new Date(NOW - 30 * 3600_000).toISOString(),
      })),
    reconcile: async (j, id) => {
      recovered.push(`${j.kind}:${id}`);
    },
    claim: async () => {
      throw Error("movement disabled");
    },
    provider: (c) => new ConnectProvider(c, fake.fetch, () => NOW),
  });
  assertEquals((await handler(request())).status, 200);
  assertEquals(recovered.length, 2);
  assertEquals(fake.calls.filter((c) => c.method === "POST").length, before);
});
Deno.test("read-only recovery with no provider receipt never creates a replacement transfer", async () => {
  const fake = new FakeStripe();
  const handler = createCreatorPayoutWorker({
    authenticate: () => {},
    bindings: () =>
      new Map([["fixture", { ...config, transfersEnabled: false }]]),
    processCommissions: async () => {},
    beginAttempt: async (j) => ({
      ...j,
      first_attempt_at: j.first_attempt_at ?? new Date(NOW).toISOString(),
    }),
    reconciliationJobs: async () => [job],
    reconcile: async () => {
      throw Error("no receipt");
    },
    provider: (c) => new ConnectProvider(c, fake.fetch, () => NOW),
  });
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(
    (await response.json()).outcomes[0].status,
    "reconciliation_pending",
  );
  assertEquals(fake.calls.filter((c) => c.method === "POST").length, 0);
});

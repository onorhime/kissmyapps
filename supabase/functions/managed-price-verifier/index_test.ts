import { assertEquals } from "@std/assert";
import { createManagedPriceVerifier } from "./index.ts";
import { ManagedProvider } from "../managed-checkout/provider.ts";
import { type Json } from "../managed-checkout/contract.ts";
import {
  FakeManagedStripe,
  fixtureBinding,
} from "../managed-checkout/test-support.ts";
const offerId = "ac570000-0000-4000-8000-000000000081";
const candidate = {
  billing_offer_id: offerId,
  product_id: fixtureBinding.productId,
  billing_mode: "payment",
  stripe_price_id: "price_ConfiguredCommercial",
  currency: "USD",
  unit_amount_minor: 16900,
  offer_version: 3,
};
function fixture() {
  const fake = new FakeManagedStripe(), writes: Json[] = [];
  let c = { ...candidate };
  const handle = createManagedPriceVerifier({
    bindings: () => new Map([[fixtureBinding.id, fixtureBinding]]),
    origins: () => new Set(["https://admin.example.invalid"]),
    candidate: () => Promise.resolve(c),
    store: {
      rpc: <T>(_name: string, input: Json) => {
        writes.push(input);
        return Promise.resolve({} as T);
      },
    },
    provider: (b) => new ManagedProvider(b, fake.fetch),
  });
  return {
    fake,
    writes,
    handle,
    setCandidate: (value: typeof c) => {
      c = value;
    },
  };
}
const request = (patch: Json = {}, headers: Record<string, string> = {}) =>
  new Request("https://fixture.invalid/managed-price-verifier", {
    method: "POST",
    headers: {
      origin: "https://admin.example.invalid",
      authorization: `Bearer ${"a".repeat(40)}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      billing_offer_id: offerId,
      binding_id: fixtureBinding.id,
      stripe_price_id: "price_ManagedFixture169",
      ...patch,
    }),
  });
Deno.test("managed price verification binds exact one-time terms to configured test account without provider writes", async () => {
  const f = fixture(), r = await f.handle(request());
  assertEquals(r.status, 200);
  const result = await r.json();
  assertEquals(result.livemode, false);
  assertEquals(result.account_id, fixtureBinding.accountId);
  assertEquals(f.writes.length, 1);
  assertEquals(f.writes[0].p_input, {
    billing_offer_id: offerId,
    product_id: fixtureBinding.productId,
    offer_version: 3,
    configured_price_id: "price_ConfiguredCommercial",
    account_id: fixtureBinding.accountId,
    livemode: false,
    stripe_price_id: "price_ManagedFixture169",
    currency: "USD",
    unit_amount_minor: 16900,
  });
  assertEquals(f.fake.calls.every((c) => c.method === "GET"), true);
});
Deno.test("managed verifier rejects unknown bindings, wrong product, price/mode/account/amount and browser authority", async () => {
  for (
    const kind of [
      "binding",
      "product",
      "price",
      "mode",
      "account",
      "amount",
      "recurring",
      "authority",
    ]
  ) {
    const f = fixture();
    let patch: Json = {};
    if (kind === "binding") patch = { binding_id: "unknown" };
    if (kind === "product") {
      f.setCandidate({ ...candidate, product_id: crypto.randomUUID() });
    }
    if (kind === "price") patch = { stripe_price_id: "price_OtherFixture" };
    if (kind === "mode") f.fake.livemode = true;
    if (kind === "account") f.fake.accountId = "acct_other";
    if (kind === "amount") f.fake.priceAmount = 1;
    if (kind === "recurring") f.fake.priceType = "recurring";
    if (kind === "authority") patch = { livemode: true };
    const r = await f.handle(request(patch));
    assertEquals(r.status >= 400, true, kind);
    assertEquals(f.writes.length, 0, kind);
  }
});
Deno.test("managed verifier rejects untrusted origins and missing admin authentication before provider access", async () => {
  for (
    const headers of [{ origin: "https://evil.invalid" }, { authorization: "" }]
  ) {
    const f = fixture();
    assertEquals(
      (await f.handle(
        request(
          {},
          Object.fromEntries(
            Object.entries(headers).filter((entry): entry is [string, string] =>
              typeof entry[1] === "string"
            ),
          ),
        ),
      )).status >=
        400,
      true,
    );
    assertEquals(f.fake.calls.length, 0);
    assertEquals(f.writes.length, 0);
  }
});

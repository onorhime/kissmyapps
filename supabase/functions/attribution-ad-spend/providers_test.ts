import { assertEquals, assertRejects } from "@std/assert";
import { type Account, readSpend } from "./providers.ts";
const from = "2026-09-12", through = "2026-09-18";
const account: Account = {
  provider: "meta",
  account_id: "321",
  currency: "USD",
  credential: "fixture",
};
const json = (body: unknown) => Promise.resolve(Response.json(body));
Deno.test("Meta reconciles paged daily spend with the same campaign label", async () => {
  let calls = 0;
  const rows = await readSpend(
    account,
    from,
    through,
    "v23.0",
    (input, init) => {
      calls++;
      const url = new URL(String(input));
      assertEquals(url.origin, "https://graph.facebook.com");
      assertEquals(url.searchParams.get("after"), calls === 1 ? null : "next");
      assertEquals(
        new Headers(init?.headers).get("Authorization"),
        "Bearer fixture",
      );
      return json({
        data: [{
          date_start: from,
          campaign_name: "Summer",
          spend: calls === 1 ? "9.19" : "0.02",
          account_currency: "USD",
        }],
        paging: calls === 1
          ? { next: "unused", cursors: { after: "next" } }
          : {},
      });
    },
  );
  assertEquals(rows, [{ day: from, campaign: "Summer", amount: 9.21 }]);
});
Deno.test("TikTok reads campaign days from a fixture and rejects incomplete data", async () => {
  const tiktok: Account = { ...account, provider: "tiktok" };
  const row = {
    dimensions: { stat_time_day: from + " 00:00:00" },
    metrics: { campaign_name: "Jade", spend: "32.10", currency: "USD" },
  };
  const rows = await readSpend(tiktok, from, through, "", (input, init) => {
    assertEquals(
      new URL(String(input)).searchParams.get("advertiser_id"),
      "321",
    );
    assertEquals(new Headers(init?.headers).get("Access-Token"), "fixture");
    return json({
      code: 0,
      data: { list: [row], page_info: { page: 1, total_page: 1 } },
    });
  });
  assertEquals(rows, [{ day: from, campaign: "Jade", amount: 32.1 }]);
  await assertRejects(
    () => readSpend(tiktok, from, through, "", () => json({ code: 40001 })),
    Error,
    "provider_rejected",
  );
  await assertRejects(
    () =>
      readSpend(tiktok, from, through, "", () =>
        json({
          code: 0,
          data: {
            list: [{ ...row, metrics: { ...row.metrics, currency: "EUR" } }],
            page_info: { page: 1, total_page: 1 },
          },
        })),
    Error,
    "currency_mismatch",
  );
});

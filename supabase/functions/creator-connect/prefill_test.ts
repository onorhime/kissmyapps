import { accountCreationParams } from "./prefill.ts";
import { assertEquals } from "./test-support.ts";

Deno.test("prefill maps only saved contact and explicit legal company fields", () => {
  assertEquals(
    accountCreationParams({
      email: " creator@example.invalid ",
      business_type: "company",
      company_name: " Example Creator Ltd ",
      website_url: "https://creator.example.invalid/about",
      full_name: "Not a legal first/last name pair",
      address: "Never inferred",
      mcc: "9999",
      capabilities: { card_payments: true },
    }),
    {
      email: "creator@example.invalid",
      business_type: "company",
      "company[name]": "Example Creator Ltd",
      "business_profile[url]": "https://creator.example.invalid/about",
    },
  );
});

Deno.test("individual names and missing entity types are never guessed", () => {
  assertEquals(
    accountCreationParams({
      business_type: "individual",
      company_name: "Personal legal name",
      first_name: "Untrusted",
      last_name: "Untrusted",
      full_name: "Known unsplit profile name",
    }),
    { business_type: "individual" },
  );
  assertEquals(
    accountCreationParams({ company_name: "Creator", full_name: "Creator" }),
    {},
  );
});

Deno.test("invalid optional legacy profile data is omitted without exposing it", () => {
  for (
    const input of [
      null,
      [],
      "text",
      { email: "bad" },
      { email: "name@example.invalid\n" },
      { business_type: "unknown" },
      { company_name: "Name" },
      { website_url: "http://example.invalid" },
      { website_url: "not a URL" },
      { website_url: "https://name:password@example.invalid" },
    ]
  ) {
    assertEquals(accountCreationParams(input), {});
  }
});

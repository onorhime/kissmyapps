import { assertEquals, assertThrows } from "@std/assert";
import { ConfigurationError } from "../_shared/errors.ts";
import {
  programPayoutBinding,
  programPayoutBindings,
  programPayoutsEnabled,
} from "./config.ts";
import {
  BINDING_ID,
  bindingEntry,
  fakeEnv,
  KEY_NAME_FIELD,
  LIVE_KEY,
  ORIGIN,
  PLATFORM,
  PUBLISHABLE,
} from "./testing.ts";

Deno.test("the switch is on only for exactly true", () => {
  for (const value of [undefined, "", "TRUE", "1", "yes", " true"]) {
    assertEquals(
      programPayoutsEnabled((name) =>
        name === "PROGRAM_PAYOUTS_ENABLED" ? value : undefined
      ),
      false,
    );
  }
  assertEquals(programPayoutsEnabled(() => "true"), true);
});

Deno.test("only the console platform's live entry is used", () => {
  const read: string[] = [];
  const env = fakeEnv({
    // Entries of other platforms are not even parsed: this one is broken.
    legacy: { platform_account_id: "acct_FakeOther", livemode: false },
    // The same platform in test mode is not for program payouts.
    sandbox: bindingEntry({ livemode: false }),
    [BINDING_ID]: bindingEntry(),
  });
  const bindings = programPayoutBindings((name) => {
    read.push(name);
    return env(name);
  });
  assertEquals([...bindings.keys()], [BINDING_ID]);
  const config = bindings.get(BINDING_ID)!;
  assertEquals(
    [
      config.platformAccountId,
      config.livemode,
      config.origin,
      config.publishableKey,
      config.countryPolicy.type,
    ],
    [PLATFORM, true, ORIGIN, PUBLISHABLE, "connect_cross_border"],
  );
  assertEquals(programPayoutBinding(env), config);
  // The legacy switches are not consulted: program payouts have their own.
  assertEquals(read.includes("CREATOR_CONNECT_ENABLED"), false);
  assertEquals(read.includes("CREATOR_TRANSFERS_ENABLED"), false);
});

Deno.test("no entry for the console platform means no binding, not an error", () => {
  for (
    const env of [
      fakeEnv({}),
      fakeEnv({ other: bindingEntry({ platform_account_id: "acct_Other1" }) }),
      fakeEnv({ sandbox: bindingEntry({ livemode: false }) }),
      fakeEnv(undefined, { CREATOR_CONNECT_BINDINGS_JSON: undefined }),
      fakeEnv(undefined, { CREATOR_CONNECT_BINDINGS_JSON: "  " }),
    ]
  ) {
    assertEquals(programPayoutBindings(env).size, 0);
    assertEquals(programPayoutBinding(env), null);
  }
});

Deno.test("an entry whose key is not a live key is not used", () => {
  const testKey = ["sk", "test", "FakePayoutKey00000000000"].join("_");
  for (
    const env of [
      fakeEnv(undefined, { FAKE_CONSOLE_KEY: testKey }),
      fakeEnv(undefined, { FAKE_CONSOLE_KEY: undefined }),
      fakeEnv(undefined, { FAKE_CONSOLE_KEY: ` ${LIVE_KEY}` }),
      fakeEnv(undefined, { FAKE_CONSOLE_KEY: ["sk", "live", "x"].join("_") }),
      fakeEnv({ [BINDING_ID]: bindingEntry({ [KEY_NAME_FIELD]: 7 }) }),
    ]
  ) {
    assertEquals(programPayoutBindings(env).size, 0);
  }
});

Deno.test("a console entry that is wrong in any other way is a configuration error", () => {
  for (
    const env of [
      fakeEnv(undefined, { CONSOLE_CONNECT_PLATFORM_ACCOUNT: undefined }),
      fakeEnv(undefined, { CONSOLE_CONNECT_PLATFORM_ACCOUNT: "FakePlatform" }),
      fakeEnv(undefined, { CREATOR_CONNECT_BINDINGS_JSON: "{" }),
      fakeEnv(undefined, { CREATOR_CONNECT_BINDINGS_JSON: "[]" }),
      // Two live entries for one platform.
      fakeEnv({ one: bindingEntry(), two: bindingEntry() }),
      fakeEnv({ "not a name": bindingEntry() }),
      fakeEnv({
        [BINDING_ID]: bindingEntry({ origin: "http://plain.example" }),
      }),
      fakeEnv({ [BINDING_ID]: bindingEntry({ refresh_url: undefined }) }),
      // Paying abroad needs the owner's word that Stripe allows it.
      fakeEnv({
        [BINDING_ID]: bindingEntry({
          country_policy: { type: "connect_cross_border" },
        }),
      }),
      fakeEnv(undefined, { FAKE_CONSOLE_SIGNING: undefined }),
      fakeEnv(undefined, {
        FAKE_CONSOLE_PUBLISHABLE: ["pk", "test", "FakeTestKey"].join("_"),
      }),
    ]
  ) {
    assertThrows(() => programPayoutBindings(env), ConfigurationError);
  }
});

Deno.test("an entry without a country policy pays creators in the platform's own country only", () => {
  const config = programPayoutBinding(
    fakeEnv({ [BINDING_ID]: bindingEntry({ country_policy: undefined }) }),
  )!;
  assertEquals(config.countryPolicy.type, "domestic");
});

import { assertEquals, assertThrows } from "@std/assert";
import { ConfigurationError } from "./errors.ts";
import {
  funnelKeyBindings,
  funnelMetricKeyBindings,
  funnelSigningSecrets,
  requiredSecret,
} from "./env.ts";

Deno.test("checked-in placeholder values never satisfy secret validation", () => {
  const requiredName = "KMA_PLACEHOLDER_SECRET_TEST";
  const previousRequired = Deno.env.get(requiredName);
  const previousHmac = Deno.env.get("FUNNEL_HMAC_BINDINGS");
  try {
    Deno.env.set(requiredName, "REPLACE_WITH_32_PLUS_RANDOM_CHARACTERS");
    assertThrows(() => requiredSecret(requiredName), ConfigurationError);

    Deno.env.set(
      "FUNNEL_HMAC_BINDINGS",
      JSON.stringify({
        REPLACE_KEY_ID: {
          secret: "REPLACE_WITH_32_PLUS_RANDOM_CHARACTERS",
          product_id: "11111111-1111-4111-8111-111111111111",
          funnel_id: "22222222-2222-4222-8222-222222222222",
        },
      }),
    );
    assertThrows(() => funnelKeyBindings(), ConfigurationError);
  } finally {
    if (previousRequired === undefined) Deno.env.delete(requiredName);
    else Deno.env.set(requiredName, previousRequired);
    if (previousHmac === undefined) {
      Deno.env.delete("FUNNEL_HMAC_BINDINGS");
    } else Deno.env.set("FUNNEL_HMAC_BINDINGS", previousHmac);
  }
});

Deno.test("funnel bindings require and expose an exact product and funnel scope", () => {
  const previous = Deno.env.get("FUNNEL_HMAC_BINDINGS");
  try {
    const secret = "a-production-strength-funnel-secret-for-tests";
    Deno.env.set(
      "FUNNEL_HMAC_BINDINGS",
      JSON.stringify({
        primary: {
          secret,
          product_id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
          funnel_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        },
      }),
    );
    const bindings = funnelKeyBindings();
    assertEquals(bindings.get("primary"), {
      secret,
      productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      funnelId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    assertEquals(funnelSigningSecrets(bindings).get("primary"), secret);

    Deno.env.set(
      "FUNNEL_HMAC_BINDINGS",
      JSON.stringify({ primary: secret }),
    );
    assertThrows(() => funnelKeyBindings(), ConfigurationError);
  } finally {
    if (previous === undefined) Deno.env.delete("FUNNEL_HMAC_BINDINGS");
    else Deno.env.set("FUNNEL_HMAC_BINDINGS", previous);
  }
});

Deno.test("dedicated telemetry bindings preserve shared keys and reject collisions or malformed scope", () => {
  const names = ["FUNNEL_HMAC_BINDINGS", "FUNNEL_METRIC_HMAC_BINDINGS"];
  const previous = names.map((name) => Deno.env.get(name));
  const shared = {
    secret: "shared-funnel-secret-for-isolated-test-only",
    product_id: "11111111-1111-4111-8111-111111111111",
    funnel_id: "22222222-2222-4222-8222-222222222222",
  };
  const metric = {
    ...shared,
    secret: "dedicated-telemetry-key-for-isolated-tests",
  };
  try {
    Deno.env.set(names[0], JSON.stringify({ legacy: shared }));
    Deno.env.set(names[1], JSON.stringify({ telemetry: metric }));
    assertEquals([...funnelMetricKeyBindings().keys()], [
      "legacy",
      "telemetry",
    ]);
    assertEquals([...funnelKeyBindings().keys()], ["legacy"]);
    Deno.env.set(names[1], JSON.stringify({ legacy: metric }));
    assertThrows(() => funnelMetricKeyBindings(), ConfigurationError);
    Deno.env.set(
      names[1],
      JSON.stringify({ telemetry: { ...metric, environment: "test" } }),
    );
    assertThrows(() => funnelMetricKeyBindings(), ConfigurationError);
    Deno.env.delete(names[0]);
    Deno.env.set(names[1], JSON.stringify({ telemetry: metric }));
    assertEquals([...funnelMetricKeyBindings().keys()], ["telemetry"]);
    Deno.env.delete(names[1]);
    assertThrows(() => funnelMetricKeyBindings(), ConfigurationError);
  } finally {
    names.forEach((name, i) =>
      previous[i] === undefined
        ? Deno.env.delete(name)
        : Deno.env.set(name, previous[i]!)
    );
  }
});

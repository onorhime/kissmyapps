import { assertEquals, assertThrows } from "@std/assert";
import { ConfigurationError } from "./errors.ts";
import {
  funnelKeyBindings,
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

import { assertEquals, assertThrows } from "@std/assert";
import { RequestError } from "../_shared/errors.ts";
import {
  requireRecentCreatorAuthentication,
  verifiedCreatorAuthentication,
} from "./auth-policy.ts";
const now = 1_800_000_000_000;
const fresh = {
  userId: "creator-user",
  assuranceLevel: "aal1",
  methods: [{ method: "password", timestamp: now / 1000 }],
  hasVerifiedMfa: false,
};
Deno.test("embedded access uses recent authentication, not token refresh or JWT issue time", () => {
  requireRecentCreatorAuthentication(fresh, now);
  for (
    const methods of [
      [],
      [{ method: "token_refresh", timestamp: now / 1000 }],
      [{ method: "password", timestamp: now / 1000 - 601 }],
      [{ method: "password", timestamp: now / 1000 + 31 }],
      [{ method: "recovery", timestamp: now / 1000 }],
      [{ method: "anonymous", timestamp: now / 1000 }],
    ]
  ) {
    const error = assertThrows(
      () => requireRecentCreatorAuthentication({ ...fresh, methods }, now),
      RequestError,
    );
    assertEquals(error.code, "reauthentication_required");
  }
});
Deno.test("enrolled MFA cannot be downgraded or bypassed with stale verification", () => {
  for (
    const extra of [{ assuranceLevel: "aal1" }, { assuranceLevel: "aal2" }, {
      assuranceLevel: "aal2",
      methods: [...fresh.methods, {
        method: "totp",
        timestamp: now / 1000 - 601,
      }],
    }]
  ) {
    const error = assertThrows(
      () =>
        requireRecentCreatorAuthentication({
          ...fresh,
          hasVerifiedMfa: true,
          ...extra,
        }, now),
      RequestError,
    );
    assertEquals(error.code, "mfa_required");
  }
  requireRecentCreatorAuthentication({
    ...fresh,
    hasVerifiedMfa: true,
    assuranceLevel: "aal2",
    methods: [...fresh.methods, { method: "totp", timestamp: now / 1000 }],
  }, now);
});
Deno.test("verified token claims must belong to authenticated non-anonymous user", () => {
  const claims = {
    sub: "creator-user",
    role: "authenticated",
    is_anonymous: false,
    aal: "aal1",
    amr: fresh.methods,
  };
  const token = (value: unknown) =>
    `header.${btoa(JSON.stringify(value))}.signature`;
  assertEquals(
    verifiedCreatorAuthentication(token(claims), {
      id: "creator-user",
      factors: [{ status: "verified" }],
    }),
    { ...fresh, hasVerifiedMfa: true },
  );
  for (
    const change of [{ sub: "other" }, { role: "service_role" }, {
      is_anonymous: true,
    }]
  ) {
    assertThrows(
      () =>
        verifiedCreatorAuthentication(token({ ...claims, ...change }), {
          id: "creator-user",
        }),
      RequestError,
    );
  }
  assertThrows(
    () => verifiedCreatorAuthentication("malformed", { id: "creator-user" }),
    RequestError,
  );
});

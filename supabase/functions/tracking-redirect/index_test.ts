import { assertEquals } from "@std/assert";
import { sessionIdFromCookie } from "./index.ts";

Deno.test("tracking session cookie parser accepts only bounded opaque values", () => {
  assertEquals(
    sessionIdFromCookie(
      "theme=dark; kma_sid=abcdefghijklmnopqrstuvwxyzABCDEF; consent=yes",
    ),
    "abcdefghijklmnopqrstuvwxyzABCDEF",
  );
  assertEquals(sessionIdFromCookie("kma_sid=short"), null);
  assertEquals(
    sessionIdFromCookie("kma_sid=contains%20spaces________________"),
    null,
  );
  assertEquals(sessionIdFromCookie(null), null);
});

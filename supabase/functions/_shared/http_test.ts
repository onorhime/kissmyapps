import { assertEquals } from "@std/assert";
import { RequestError } from "./errors.ts";
import { errorResponse } from "./http.ts";

Deno.test("rate-limit responses include a bounded retry hint", async () => {
  const response = errorResponse(
    new RequestError(429, "rate_limited", "Too many requests."),
    "request_12345678",
  );

  assertEquals(response.status, 429);
  assertEquals(response.headers.get("retry-after"), "60");
  assertEquals(response.headers.get("cache-control"), "no-store, max-age=0");
  assertEquals(await response.json(), {
    error: "rate_limited",
    message: "Too many requests.",
    request_id: "request_12345678",
  });
});

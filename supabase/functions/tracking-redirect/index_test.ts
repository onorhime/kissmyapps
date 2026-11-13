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

Deno.test("readable and legacy redirects share session hashes, attribution tokens and response protections", async () => {
  const { handleTrackingRedirect } = await import("./index.ts");
  const names = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "TRACKING_HASH_SECRET",
  ];
  const previous = names.map((name) => Deno.env.get(name));
  const oldFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  try {
    Deno.env.set("SUPABASE_URL", "https://alias-test.supabase.invalid");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-role-key");
    Deno.env.set(
      "TRACKING_HASH_SECRET",
      "synthetic-tracking-hash-secret-for-tests-only",
    );
    globalThis.fetch = (_input, init) => {
      calls.push({ url: String(_input), body: JSON.parse(String(init?.body)) });
      return Promise.resolve(
        new Response(
          JSON.stringify([{
            click_id: "c".repeat(48),
            destination_url:
              "https://marathon.speaksix.com/?campaign=spring#start",
            is_bot: false,
          }]),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    };
    for (
      const path of ["/speaksix/王小明", "/r/old-creator/abcdefghijklmnop"]
    ) {
      const response = await handleTrackingRedirect(
        new Request(`https://go.kissmyapps.dev${path}`, {
          headers: {
            "user-agent": "Local browser",
            cookie: `kma_sid=${"s".repeat(32)}`,
          },
        }),
      );
      assertEquals(response.status, 302);
      assertEquals(
        response.headers.get("location"),
        `https://marathon.speaksix.com/?campaign=spring&kma_click=${
          "c".repeat(48)
        }#start`,
      );
      assertEquals(response.headers.get("set-cookie"), null);
      assertEquals(
        response.headers.get("cache-control"),
        "no-store, max-age=0",
      );
      assertEquals(
        response.headers.get("x-robots-tag"),
        "noindex, nofollow, noarchive",
      );
    }
    assertEquals(
      calls[0].url.endsWith("/rpc/register_short_tracking_click"),
      true,
    );
    assertEquals(calls[0].body.p_path, "/speaksix/王小明");
    assertEquals(calls[1].url.endsWith("/rpc/register_tracking_click"), true);
    assertEquals(calls[1].body.p_affiliate_slug, "old-creator");
    assertEquals(calls[0].body.p_context, calls[1].body.p_context);
    const before = calls.length;
    assertEquals(
      (await handleTrackingRedirect(
        new Request("https://go.kissmyapps.dev/speaksix/victory%2fbio"),
      )).status,
      404,
    );
    assertEquals(
      (await handleTrackingRedirect(
        new Request("https://go.kissmyapps.dev/speaksix/victory", {
          method: "POST",
        }),
      )).status,
      405,
    );
    assertEquals(calls.length, before);
  } finally {
    globalThis.fetch = oldFetch;
    names.forEach((name, index) =>
      previous[index] === undefined
        ? Deno.env.delete(name)
        : Deno.env.set(name, previous[index]!)
    );
  }
});

/** Runs the handler against a database stand-in that answers every click RPC with `row`. */
async function withClickAnswer(
  row: Record<string, unknown>,
  run: (
    calls: { url: string; body: Record<string, unknown> }[],
  ) => Promise<void>,
): Promise<void> {
  const names = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "TRACKING_HASH_SECRET",
  ];
  const previous = names.map((name) => Deno.env.get(name));
  const oldFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  try {
    Deno.env.set("SUPABASE_URL", "https://untracked-test.supabase.invalid");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-role-key");
    Deno.env.set(
      "TRACKING_HASH_SECRET",
      "synthetic-tracking-hash-secret-for-tests-only",
    );
    globalThis.fetch = (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Promise.resolve(
        new Response(JSON.stringify([row]), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    };
    await run(calls);
  } finally {
    globalThis.fetch = oldFetch;
    names.forEach((name, index) =>
      previous[index] === undefined
        ? Deno.env.delete(name)
        : Deno.env.set(name, previous[index]!)
    );
  }
}

Deno.test("a program link that cannot be credited redirects to the stored landing page with no click and no cookie", async () => {
  const { handleTrackingRedirect } = await import("./index.ts");
  await withClickAnswer({
    click_id: null,
    destination_url: "https://lingo-app.io/start?campaign=spring#top",
    is_bot: false,
  }, async (calls) => {
    for (
      const [path, headers] of [
        ["/r/ada-okafor/abcdefghijklmnop", { "user-agent": "Local browser" }],
        ["/lingo/ada-okafor", { "user-agent": "Local browser" }],
        ["/r/ada-okafor/abcdefghijklmnop", {
          "user-agent": "Local browser",
          cookie: `kma_sid=${"s".repeat(32)}`,
        }],
      ] as const
    ) {
      const response = await handleTrackingRedirect(
        new Request(`https://go.kissmyapps.dev${path}`, { headers }),
      );
      assertEquals(response.status, 302);
      assertEquals(
        response.headers.get("location"),
        "https://lingo-app.io/start?campaign=spring#top",
      );
      assertEquals(response.headers.get("set-cookie"), null);
      assertEquals(
        response.headers.get("cache-control"),
        "no-store, max-age=0",
      );
      assertEquals(
        response.headers.get("x-robots-tag"),
        "noindex, nofollow, noarchive",
      );
      assertEquals(response.headers.get("referrer-policy"), "no-referrer");
      assertEquals(await response.text(), "");
    }
    assertEquals(calls.length, 3);
    assertEquals(calls[0].url.endsWith("/rpc/register_tracking_click"), true);
    assertEquals(
      calls[1].url.endsWith("/rpc/register_short_tracking_click"),
      true,
    );
  });
});

Deno.test("an untracked redirect drops a creator tag stored on the landing page and still refuses unsafe destinations", async () => {
  const { handleTrackingRedirect } = await import("./index.ts");
  const visit = () =>
    handleTrackingRedirect(
      new Request("https://go.kissmyapps.dev/r/ada-okafor/abcdefghijklmnop"),
    );
  await withClickAnswer({
    click_id: null,
    destination_url: "https://lingo-app.io/start?kma_click=stale&plan=pro",
    is_bot: false,
  }, async () => {
    assertEquals(
      (await visit()).headers.get("location"),
      "https://lingo-app.io/start?plan=pro",
    );
  });
  for (
    const destination of [
      "http://lingo-app.io/start",
      "https://user:pw@lingo-app.io/start",
      "javascript:alert(1)",
    ]
  ) {
    await withClickAnswer(
      { click_id: null, destination_url: destination, is_bot: false },
      async () => {
        const response = await visit();
        assertEquals(response.status, 503);
        assertEquals(response.headers.get("location"), null);
        assertEquals(response.headers.get("set-cookie"), null);
        assertEquals((await response.json()).error, "invalid_destination");
      },
    );
  }
});

Deno.test("a recorded click still starts a session and carries its click id; a click row without an id is unavailable", async () => {
  const { handleTrackingRedirect } = await import("./index.ts");
  const visit = () =>
    handleTrackingRedirect(
      new Request("https://go.kissmyapps.dev/r/ada-okafor/abcdefghijklmnop"),
    );
  await withClickAnswer({
    click_id: "d".repeat(48),
    destination_url: "https://lingo-app.io/start",
    is_bot: false,
  }, async () => {
    const response = await visit();
    assertEquals(response.status, 302);
    assertEquals(
      response.headers.get("location"),
      `https://lingo-app.io/start?kma_click=${"d".repeat(48)}`,
    );
    assertEquals(
      /^kma_sid=[A-Za-z0-9_-]{32}; Max-Age=31536000; Path=\/; Secure; HttpOnly; SameSite=Lax$/
        .test(response.headers.get("set-cookie") ?? ""),
      true,
    );
  });
  // Only an explicit null means "redirect only".
  await withClickAnswer(
    { destination_url: "https://lingo-app.io/start", is_bot: false },
    async () => {
      const response = await visit();
      assertEquals(response.status, 404);
      assertEquals(response.headers.get("location"), null);
      assertEquals(response.headers.get("set-cookie"), null);
    },
  );
});

import { assertEquals } from "@std/assert";
import { ConfigurationError } from "../_shared/errors.ts";
import {
  createAttributionLinksHandler,
  type LinkDependencies,
  type LinkHost,
} from "./index.ts";

const secret = "s".repeat(40);
const speaksix: LinkHost = {
  host: "speaksix.go.kissmyapps.dev",
  project_id: "eff8dda2-6ece-474a-87da-bd604a2c8602",
  kind: "kma",
  enabled: true,
  ios_app_ids: ["ABCDE12345.app.speaksix.ios"],
  android: { package: "app.speaksix", sha256: ["AB:CD"] },
  web_url: "https://speaksix.app/",
};

function setup(overrides: Partial<LinkDependencies> = {}) {
  const calls: string[] = [];
  const handler = createAttributionLinksHandler({
    secret: () => secret,
    host: (host) => {
      calls.push(`host ${host}`);
      return Promise.resolve({
        data: host === speaksix.host ? speaksix : null,
        error: null,
      });
    },
    seen: (host) => {
      calls.push(`seen ${host}`);
      return Promise.resolve({ data: true, error: null });
    },
    ...overrides,
  });
  return { calls, handler };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://edge.example/functions/v1/attribution-links", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kma-link-secret": secret,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

Deno.test("a known host gives what its domain serves", async () => {
  const { calls, handler } = setup();
  const response = await handler(
    post({ action: "host", host: " SpeakSix.Go.KissMyApps.dev. " }),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { domain: speaksix });
  assertEquals(calls, ["host speaksix.go.kissmyapps.dev"]);
  assertEquals(response.headers.get("cache-control"), "no-store, max-age=0");
});

Deno.test("an unknown host gives no domain", async () => {
  const { handler } = setup();
  const response = await handler(
    post({ action: "host", host: "nobody.example" }),
  );
  assertEquals(await response.json(), { domain: null });
});

Deno.test("a reached host is marked seen", async () => {
  const { calls, handler } = setup();
  const response = await handler(
    post({ action: "seen", host: "go.speaksix.app" }),
  );
  assertEquals(await response.json(), { seen: true });
  assertEquals(calls, ["seen go.speaksix.app"]);
});

Deno.test("only the link service's secret is let in", async () => {
  const { calls, handler } = setup();
  for (
    const headers of [
      { "x-kma-link-secret": "wrong" },
      { "x-kma-link-secret": secret.slice(1) },
      { "x-kma-link-secret": "" },
    ]
  ) {
    const response = await handler(
      post({ action: "host", host: speaksix.host }, headers),
    );
    assertEquals(response.status, 401);
  }
  assertEquals(calls, []);
});

Deno.test("without a secret configured, nothing is answered", async () => {
  const { handler } = setup({
    secret: () => {
      throw new ConfigurationError();
    },
  });
  const response = await handler(post({ action: "host", host: speaksix.host }));
  assertEquals(response.status, 503);
});

Deno.test("requests are POSTs with a host and a known action", async () => {
  const { calls, handler } = setup();
  const get = await handler(
    new Request("https://edge.example/functions/v1/attribution-links"),
  );
  assertEquals(get.status, 405);
  for (
    const body of [
      { action: "host", host: "not a host" },
      { action: "host" },
      { action: "host", host: "a".repeat(250) + ".com" },
      { action: "delete", host: speaksix.host },
      [],
    ]
  ) {
    const response = await handler(post(body));
    assertEquals(response.status, 400, JSON.stringify(body));
  }
  assertEquals(calls, []);
});

Deno.test("a database failure is a retryable error", async () => {
  const { handler } = setup({
    host: () =>
      Promise.resolve({
        data: null,
        error: { code: "57014", message: "timeout" },
      }),
  });
  const response = await handler(post({ action: "host", host: speaksix.host }));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).error, "unavailable");
});

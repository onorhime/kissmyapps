import { assertEquals } from "@std/assert";
import { ConfigurationError } from "../_shared/errors.ts";
import {
  type Click,
  createAttributionLinksHandler,
  type LinkDependencies,
  type LinkHost,
  type LinkTarget,
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

const launch: LinkTarget = {
  id: "0b6d3c8e-7a4f-4e21-9d6b-2f1c5e8a9b70",
  project_id: speaksix.project_id,
  project_name: "SpeakSix",
  path: "october-launch",
  status: "active",
  source: "tiktok_ads",
  campaign: "october_launch",
  channel: null,
  adset: null,
  ad: null,
  deep_link_value: "lesson",
  deep_link_params: { id: "4" },
  web_url: "https://speaksix.app/start",
  ios_url: "https://apps.apple.com/app/id1612345678",
  ios_custom: false,
  android_url: null,
  android_package: "app.speaksix",
  social: null,
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

function setup(overrides: Partial<LinkDependencies> = {}) {
  const calls: string[] = [];
  const recorded: Click[][] = [];
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
    link: (host, path) => {
      calls.push(`link ${host} ${path}`);
      return Promise.resolve({
        data: host === speaksix.host && path === "october-launch"
          ? launch
          : null,
        error: null,
      });
    },
    clicks: (clicks) => {
      recorded.push(clicks);
      return Promise.resolve({ data: clicks.length, error: null });
    },
    ipSalt: () => "salt",
    ...overrides,
  });
  return { calls, handler, recorded };
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

Deno.test("a link on a known host gives where it leads", async () => {
  const { calls, handler } = setup();
  const response = await handler(
    post({ action: "link", host: speaksix.host, path: "october-launch" }),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { link: launch });
  assertEquals(calls, [`link ${speaksix.host} october-launch`]);
  const unknown = await handler(
    post({ action: "link", host: speaksix.host, path: "nothing" }),
  );
  assertEquals(await unknown.json(), { link: null });
  for (const path of ["", "a/b", "../x", "a".repeat(70), 7]) {
    const bad = await handler(
      post({ action: "link", host: speaksix.host, path }),
    );
    assertEquals(bad.status, 400, String(path));
  }
});

Deno.test("clicks are stored with the address hashed, never raw", async () => {
  const { handler, recorded } = setup();
  const response = await handler(post({
    action: "clicks",
    clicks: [
      { id: "a".repeat(22), link_id: launch.id, ip: "102.89.1.2" },
      { id: "b".repeat(22), link_id: launch.id, ip: "not an address" },
      { id: "c".repeat(22), link_id: launch.id },
      "junk",
    ],
  }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { stored: 3 });
  assertEquals(recorded, [[
    {
      id: "a".repeat(22),
      link_id: launch.id,
      ip_sha: await sha256("salt:102.89.1.2"),
    },
    { id: "b".repeat(22), link_id: launch.id },
    { id: "c".repeat(22), link_id: launch.id },
  ]]);
  for (const clicks of [[], "x", Array.from({ length: 501 }, () => ({}))]) {
    const bad = await handler(post({ action: "clicks", clicks }));
    assertEquals(bad.status, 400);
  }
  const failing = setup({
    clicks: () =>
      Promise.resolve({ data: null, error: { message: "timeout" } }),
  });
  const down = await failing.handler(
    post({ action: "clicks", clicks: [{ id: "d".repeat(22) }] }),
  );
  assertEquals(down.status, 503);
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

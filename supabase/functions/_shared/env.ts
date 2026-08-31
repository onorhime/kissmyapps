import { ConfigurationError } from "./errors.ts";

export function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new ConfigurationError();
  return value;
}

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return normalized.includes("REPLACE_WITH") ||
    normalized.includes("CHANGE_ME") ||
    normalized === "CHANGEME" ||
    normalized === "INVALID";
}

export function requiredSecret(name: string, minimumLength = 32): string {
  const value = requiredEnv(name);
  if (value.length < minimumLength || isPlaceholderSecret(value)) {
    throw new ConfigurationError();
  }
  return value;
}

export function serviceRoleKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (legacy) return legacy;

  const encoded = Deno.env.get("SUPABASE_SECRET_KEYS")?.trim();
  if (!encoded) throw new ConfigurationError();
  try {
    const values = JSON.parse(encoded) as Record<string, unknown>;
    const defaultKey = values.default;
    if (typeof defaultKey === "string" && defaultKey.length > 0) {
      return defaultKey;
    }
  } catch {
    // Deliberately collapse malformed secret configuration to a generic failure.
  }
  throw new ConfigurationError();
}

function validatedProductionOrigin(rawOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new ConfigurationError();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname.endsWith(".test") ||
    parsed.hostname.endsWith(".invalid")
  ) {
    throw new ConfigurationError();
  }
  return parsed.origin;
}

export function productionOrigins(name: string): ReadonlySet<string> {
  const configured = requiredEnv(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(validatedProductionOrigin);
  if (configured.length === 0) throw new ConfigurationError();
  return new Set(configured);
}

export function configuredNames(name: string): ReadonlySet<string> {
  const values = requiredEnv(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    values.length === 0 ||
    values.some((value) => !/^[a-z][a-z0-9_.-]{0,99}$/.test(value))
  ) {
    throw new ConfigurationError();
  }
  return new Set(values);
}

export function optionalConfiguredNames(name: string): ReadonlySet<string> {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return new Set();
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.some((value) => !/^[a-z][a-z0-9_]{0,79}$/.test(value))) {
    throw new ConfigurationError();
  }
  return new Set(values);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface FunnelKeyBinding {
  secret: string;
  productId: string;
  funnelId: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function funnelKeyBindings(): ReadonlyMap<string, FunnelKeyBinding> {
  const encoded = requiredEnv("FUNNEL_HMAC_BINDINGS");
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!isPlainRecord(parsed)) throw new ConfigurationError();
    const entries = Object.entries(parsed);
    if (
      entries.length === 0 || entries.length > 100 ||
      entries.some(([key, value]) => {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(key) || !isPlainRecord(value)) {
          return true;
        }
        const keys = Object.keys(value).sort();
        return keys.length !== 3 ||
          keys[0] !== "funnel_id" ||
          keys[1] !== "product_id" ||
          keys[2] !== "secret" ||
          typeof value.secret !== "string" ||
          value.secret.length < 32 ||
          isPlaceholderSecret(value.secret) ||
          typeof value.product_id !== "string" ||
          !UUID_PATTERN.test(value.product_id) ||
          typeof value.funnel_id !== "string" ||
          !UUID_PATTERN.test(value.funnel_id);
      })
    ) {
      throw new ConfigurationError();
    }
    return new Map(entries.map(([key, value]) => {
      const binding = value as {
        secret: string;
        product_id: string;
        funnel_id: string;
      };
      return [key, {
        secret: binding.secret,
        productId: binding.product_id.toLowerCase(),
        funnelId: binding.funnel_id.toLowerCase(),
      }];
    }));
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError();
  }
}

export function funnelSigningSecrets(
  bindings: ReadonlyMap<string, FunnelKeyBinding>,
): ReadonlyMap<string, string> {
  return new Map(
    Array.from(bindings, ([keyId, binding]) => [keyId, binding.secret]),
  );
}

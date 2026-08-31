import { RequestError } from "./errors.ts";

const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function hexToBytes(value: string): Uint8Array | null {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

export function constantTimeEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  const maximumLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximumLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function constantTimeEqualStrings(left: string, right: string): boolean {
  return constantTimeEqual(encoder.encode(left), encoder.encode(right));
}

export async function hmacSha256(
  secret: string,
  message: Uint8Array | string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = typeof message === "string"
    ? encoder.encode(message)
    : message;
  const payloadBuffer = Uint8Array.from(payload).buffer;
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadBuffer));
}

export async function privateSignalHash(
  secret: string,
  label: string,
  value: string | null,
): Promise<string | null> {
  if (!value) return null;
  return bytesToHex(await hmacSha256(secret, `${label}:${value}`));
}

export function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/u,
    "",
  );
}

export interface FunnelSignatureInput {
  keyId: string;
  nonce: string;
  timestamp: number;
  signature: string;
}

export function parseFunnelSignatureHeaders(
  headers: Headers,
): FunnelSignatureInput {
  const keyId = headers.get("x-kma-key-id")?.trim() ?? "";
  const nonce = headers.get("x-kma-nonce")?.trim() ?? "";
  const timestampValue = headers.get("x-kma-timestamp")?.trim() ?? "";
  const signature = headers.get("x-kma-signature")?.trim().toLowerCase() ?? "";
  const timestamp = Number(timestampValue);
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(keyId) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
    !Number.isSafeInteger(timestamp) ||
    !/^[0-9a-f]{64}$/.test(signature)
  ) {
    throw new RequestError(
      401,
      "invalid_signature",
      "Request authentication failed.",
    );
  }
  return { keyId, nonce, timestamp, signature };
}

export async function verifyFunnelSignature(
  body: Uint8Array,
  signatureInput: FunnelSignatureInput,
  secrets: ReadonlyMap<string, string>,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): Promise<void> {
  if (Math.abs(nowSeconds - signatureInput.timestamp) > toleranceSeconds) {
    throw new RequestError(
      401,
      "expired_signature",
      "Request authentication failed.",
    );
  }
  const secret = secrets.get(signatureInput.keyId);
  if (!secret) {
    throw new RequestError(
      401,
      "invalid_signature",
      "Request authentication failed.",
    );
  }
  const prefix = encoder.encode(
    `${signatureInput.timestamp}.${signatureInput.nonce}.`,
  );
  const canonical = new Uint8Array(prefix.byteLength + body.byteLength);
  canonical.set(prefix);
  canonical.set(body, prefix.byteLength);
  const expected = await hmacSha256(secret, canonical);
  const supplied = hexToBytes(signatureInput.signature);
  if (!supplied || !constantTimeEqual(expected, supplied)) {
    throw new RequestError(
      401,
      "invalid_signature",
      "Request authentication failed.",
    );
  }
}

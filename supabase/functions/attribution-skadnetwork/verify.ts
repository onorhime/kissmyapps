// The published Apple P-256 key for SKAdNetwork 2.1 and later.
// https://developer.apple.com/documentation/storekit/verifying-an-install-validation-postback
function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
const appleKey = crypto.subtle.importKey(
  "spki",
  fromBase64(
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWdp8GPcGqmhgzEFj9Z2nSpQVddayaPe4FMzqM9wib1+aHaaIzoHoLN9zW4K8y4SPykE3YVK3sVqW6Af0lfx3gg==",
  ),
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["verify"],
);

// Apple sends a DER SEQUENCE of two positive INTEGERs. WebCrypto takes the
// fixed-width unsigned r and s scalars concatenated. P-256 needs only short lengths.
function rawSignature(encoded: string): Uint8Array<ArrayBuffer> | null {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(encoded);
  } catch {
    return null;
  }
  if (bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) return null;
  let index = 2;
  const raw = new Uint8Array(64);
  for (const offset of [0, 32]) {
    if (bytes[index++] !== 2) return null;
    const length = bytes[index++];
    if (!length || length > 33 || index + length > bytes.length) return null;
    let scalar = bytes.subarray(index, index + length);
    index += length;
    if (scalar[0] & 0x80) return null;
    if (scalar.length > 1 && scalar[0] === 0) {
      if (!(scalar[1] & 0x80)) return null;
      scalar = scalar.subarray(1);
    }
    if (scalar.length > 32) return null;
    raw.set(scalar, offset + 32 - scalar.length);
  }
  return index === bytes.length ? raw : null;
}
export async function verifyPostback(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const p = input as Record<string, unknown>;
  const version = p.version,
    network = p["ad-network-id"],
    transaction = p["transaction-id"];
  if (
    !["2.1", "2.2", "3.0", "4.0"].includes(String(version)) ||
    typeof network !== "string" || !/^[a-zA-Z0-9.-]{1,120}$/.test(network) ||
    typeof transaction !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(transaction) ||
    !Number.isSafeInteger(p["app-id"]) || typeof p.redownload !== "boolean"
  ) return null;
  const modern = version === "4.0";
  const source = modern ? p["source-identifier"] : p["campaign-id"];
  if (
    modern
      ? typeof source !== "string" || !/^\d{2,4}$/.test(source)
      : !Number.isInteger(source) || Number(source) < 1 || Number(source) > 100
  ) return null;
  const fields = [
    version,
    network,
    source,
    p["app-id"],
    transaction,
    p.redownload,
  ];
  if (p["source-app-id"] !== undefined) {
    if (
      !Number.isSafeInteger(p["source-app-id"]) ||
      p["source-domain"] !== undefined
    ) return null;
    fields.push(p["source-app-id"]);
  } else if (p["source-domain"] !== undefined) {
    if (
      !modern || typeof p["source-domain"] !== "string" ||
      !/^[a-zA-Z0-9.-]{1,253}$/.test(p["source-domain"])
    ) return null;
    fields.push(p["source-domain"]);
  }
  if (version !== "2.1") {
    if (![0, 1].includes(p["fidelity-type"] as number)) return null;
    fields.push(p["fidelity-type"]);
  }
  if (modern || version === "3.0") {
    if (typeof p["did-win"] !== "boolean") return null;
    fields.push(p["did-win"]);
  }
  const sequence = modern ? p["postback-sequence-index"] : 0;
  if (![0, 1, 2].includes(sequence as number)) return null;
  if (modern) fields.push(sequence);
  const signature = p["attribution-signature"];
  if (typeof signature !== "string" || signature.length > 128) return null;
  const raw = rawSignature(signature);
  if (
    !raw ||
    !await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await appleKey,
      raw,
      new TextEncoder().encode(fields.join("\u2063")),
    )
  ) return null;
  return {
    transaction,
    app_id: String(p["app-id"]),
    network,
    source: String(source),
    sequence,
    redownload: p.redownload,
    won: p["did-win"] !== false,
    version,
  };
}

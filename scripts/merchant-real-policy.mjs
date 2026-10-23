/** Guards for an explicitly approved TEST-only merchant rehearsal. */
export const merchantOrigin = "http://127.0.0.1:5194";
export function merchantRealOptions(input) {
  if (
    input.enabled !== true ||
    !/^sk_test_[A-Za-z0-9]{12,}$/.test(input.key ?? "")
  ) {
    throw Error(
      "Explicit activation and a Stripe TEST secret key are required.",
    );
  }
  if (
    !/^acct_[A-Za-z0-9]+$/.test(input.platformAccountId ?? "") ||
    !/^ca_[A-Za-z0-9]+$/.test(input.clientId ?? "")
  ) {
    throw Error(
      "The verified platform account and TEST OAuth client ID are required.",
    );
  }
  return {
    key: input.key,
    platformAccountId: input.platformAccountId,
    clientId: input.clientId,
    origin: merchantOrigin,
  };
}
export function merchantRealTransport(
  options,
  permittedMerchant,
  fetcher = fetch,
) {
  merchantRealOptions({ ...options, enabled: true });
  return async (input, init = {}) => {
    const u = new URL(String(input)),
      h = new Headers(init.headers),
      method = init.method ?? "GET";
    if (u.username || u.password || u.hash || init.redirect !== "error") {
      throw Error("Unsafe provider request.");
    }
    const bearer = h.get("authorization") === `Bearer ${options.key}`;
    const basic = h.get("authorization") === `Basic ${btoa(`${options.key}:`)}`;
    if (
      u.origin === "https://connect.stripe.com" &&
      u.pathname === "/oauth/token" && method === "POST" && basic &&
      !h.has("stripe-account")
    ) {
      const form = new URLSearchParams(String(init.body ?? ""));
      if (
        form.get("grant_type") !== "authorization_code" ||
        !/^ac_[A-Za-z0-9_]+$/.test(form.get("code") ?? "") ||
        [...form.keys()].some((k) => !["grant_type", "code"].includes(k))
      ) throw Error("Only a single OAuth code exchange is permitted.");
      return await fetcher(u, init);
    }
    if (
      u.origin !== "https://api.stripe.com" || !u.pathname.startsWith("/v1/") ||
      (!bearer && !basic)
    ) throw Error("Foreign provider request denied.");
    const account = h.get("stripe-account");
    if (
      account &&
      (!/^acct_[A-Za-z0-9]+$/.test(account) ||
        account === options.platformAccountId)
    ) throw Error("Invalid merchant scope.");
    if (method === "GET") return await fetcher(u, init);
    const merchant = permittedMerchant();
    const merchantWrite =
      /^\/v1\/checkout\/sessions(?:\/cs_[A-Za-z0-9_]+\/expire)?$/.test(
        u.pathname,
      ) || u.pathname === "/v1/refunds";
    const feeWrite = /^\/v1\/application_fees\/fee_[A-Za-z0-9]+\/refunds$/.test(
      u.pathname,
    );
    if (
      method !== "POST" || !merchant ||
      (merchantWrite
        ? account !== merchant
        : feeWrite
        ? account !== null
        : true)
    ) {
      throw Error(
        "Only confirmed TEST merchant checkout and refund writes are permitted.",
      );
    }
    return await fetcher(u, init);
  };
}

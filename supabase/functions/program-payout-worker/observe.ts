// The legacy ConnectProvider answers a refused request with one of two codes
// and keeps the platform's balance to itself. The payout worker needs a little
// more to decide well, and may not change the provider. So it hands the
// provider a fetch that looks at what goes by: how much the platform has
// available, and how Stripe refused the last request. Nothing else is kept,
// and no request or answer is changed.

/** How Stripe refused a request. */
export interface Refusal {
  method: string;
  status: number;
  /** Stripe's error code, when it is a plain code. */
  code: string | null;
  /** Stripe did not run the request again: it repeated a stored answer. */
  replayed: boolean;
}

export interface StripeWatch {
  /** Give this to the provider instead of fetch. */
  fetch: typeof fetch;
  /**
   * What the platform has available per currency (upper case, minor units),
   * from the last read of its balance. Null until it was read.
   */
  funds: Map<string, number> | null;
  /** The refusal of the latest request; null when it was not refused. */
  refusal: Refusal | null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function availableFunds(body: unknown): Map<string, number> {
  const funds = new Map<string, number>();
  const rows = record(body).available;
  for (const row of Array.isArray(rows) ? rows : []) {
    const { currency, amount } = record(row);
    if (
      typeof currency === "string" && typeof amount === "number" &&
      Number.isSafeInteger(amount)
    ) {
      const key = currency.toUpperCase();
      funds.set(key, (funds.get(key) ?? 0) + amount);
    }
  }
  return funds;
}

export function watchStripe(fetcher: typeof fetch): StripeWatch {
  const watch: StripeWatch = {
    funds: null,
    refusal: null,
    fetch: async (input, init) => {
      watch.refusal = null;
      const response = await fetcher(input, init);
      try {
        if (!response.ok) {
          let code: unknown;
          try {
            code = record(record(await response.clone().json()).error).code;
          } catch { /* Not JSON: the status alone is kept. */ }
          watch.refusal = {
            method: (init?.method ?? "GET").toUpperCase(),
            status: response.status,
            code:
              typeof code === "string" && /^[a-z][a-z0-9_]{1,59}$/.test(code)
                ? code
                : null,
            replayed: response.headers.get("idempotent-replayed") === "true",
          };
        } else {
          const address = input instanceof Request ? input.url : String(input);
          if (new URL(address).pathname === "/v1/balance") {
            watch.funds = availableFunds(await response.clone().json());
          }
        }
      } catch { /* Watching never changes what the provider is given. */ }
      return response;
    },
  };
  return watch;
}

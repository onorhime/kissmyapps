import { ConfigurationError, RequestError } from "../_shared/errors.ts";
import {
  accountCreationParams,
  type AccountCreationPrefill,
} from "./prefill.ts";
import {
  STRIPE_API_VERSION,
  stripeRequestSignal,
} from "../_shared/stripe-api.ts";

export type JsonObject = Record<string, unknown>;
export interface ConnectConfig {
  platformAccountId: string;
  livemode: boolean;
  secret: string;
  publishableKey?: string;
  webhookSecret: string;
  origin: string;
  returnUrl: string;
  refreshUrl: string;
  countryPolicy: {
    type: "domestic" | "connect_cross_border" | "approved_countries";
    approvalReference?: string;
    approvedCountries?: string[];
  };
  transfersEnabled: boolean;
}

// Reading configuration is lazy. Disabled handlers do not read provider keys.
export function connectBindings(
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): Map<string, ConnectConfig> {
  if (env("CREATOR_CONNECT_ENABLED") !== "true") return new Map();
  let bindings: JsonObject;
  try {
    bindings = object(JSON.parse(env("CREATOR_CONNECT_BINDINGS_JSON") ?? ""));
  } catch {
    throw new ConfigurationError();
  }
  if (Object.keys(bindings).length === 0 || Object.keys(bindings).length > 10) {
    throw new ConfigurationError();
  }
  const result = new Map<string, ConnectConfig>();
  for (const [key, value] of Object.entries(bindings)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) throw new ConfigurationError();
    const config = parseConfig(object(value), env);
    if (
      [...result.values()].some((entry) =>
        entry.platformAccountId === config.platformAccountId &&
        entry.livemode === config.livemode
      )
    ) throw new ConfigurationError();
    result.set(key, config);
  }
  return result;
}
function parseConfig(
  raw: JsonObject,
  env: (name: string) => string | undefined,
): ConnectConfig {
  const platformAccountId = identifier(raw.platform_account_id, "acct_");
  const livemode = raw.livemode;
  if (typeof livemode !== "boolean") throw new ConfigurationError();
  const secretName = raw.secret_env, webhookName = raw.webhook_secret_env;
  if (
    typeof secretName !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(secretName) ||
    typeof webhookName !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(webhookName)
  ) throw new ConfigurationError();
  const secret = env(secretName) ?? "", webhookSecret = env(webhookName) ?? "";
  if (
    !new RegExp(`^(?:sk|rk)_${livemode ? "live" : "test"}_.+`).test(secret) ||
    !webhookSecret.startsWith("whsec_")
  ) throw new ConfigurationError();
  const publishableName = raw.publishable_key_env;
  let publishableKey: string | undefined;
  if (publishableName !== undefined) {
    if (
      typeof publishableName !== "string" ||
      !/^[A-Z][A-Z0-9_]+$/.test(publishableName)
    ) {
      throw new ConfigurationError();
    }
    publishableKey = env(publishableName);
    if (
      !new RegExp(`^pk_${livemode ? "live" : "test"}_[A-Za-z0-9]+$`).test(
        publishableKey ?? "",
      )
    ) {
      throw new ConfigurationError();
    }
  }
  const origin = String(raw.origin ?? ""),
    returnUrl = String(raw.return_url ?? ""),
    refreshUrl = String(raw.refresh_url ?? "");
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
    for (const address of [origin, returnUrl, refreshUrl]) {
      const url = new URL(address);
      if (
        url.origin !== origin || url.username || url.password || url.hash ||
        (url.protocol !== "https:" &&
          !(url.protocol === "http:" && !livemode &&
            ["localhost", "127.0.0.1"].includes(url.hostname)))
      ) throw new Error();
    }
  } catch {
    throw new ConfigurationError();
  }
  if (parsedOrigin.origin !== origin || returnUrl === refreshUrl) {
    throw new ConfigurationError();
  }
  // The country catalog is provider-owned. This is an attestation of the
  // platform's approved funds flow, never a replacement worldwide allowlist.
  const policy = raw.country_policy === undefined
    ? { type: "domestic" }
    : object(raw.country_policy);
  if (
    !["domestic", "connect_cross_border", "approved_countries"].includes(
      String(policy.type),
    ) ||
    (policy.type !== "domestic" &&
      (typeof policy.approval_reference !== "string" ||
        policy.approval_reference.trim().length < 8 ||
        policy.approval_reference.length > 200)) ||
    (policy.type === "approved_countries" &&
      (!Array.isArray(policy.approved_countries) ||
        !policy.approved_countries.length ||
        policy.approved_countries.some((v) =>
          typeof v !== "string" || !/^[A-Z]{2}$/.test(v)
        ))) ||
    raw.allowed_countries !== undefined
  ) throw new ConfigurationError();
  return {
    platformAccountId,
    livemode,
    secret,
    publishableKey,
    webhookSecret,
    origin,
    returnUrl,
    refreshUrl,
    countryPolicy: {
      type: policy.type as ConnectConfig["countryPolicy"]["type"],
      ...(typeof policy.approval_reference === "string"
        ? { approvalReference: policy.approval_reference }
        : {}),
      ...(Array.isArray(policy.approved_countries)
        ? { approvedCountries: policy.approved_countries as string[] }
        : {}),
    },
    transfersEnabled: env("CREATOR_TRANSFERS_ENABLED") === "true",
  };
}

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "invalid_object", "Invalid request object.");
  }
  return value as JsonObject;
}
export function identifier(value: unknown, prefix: string): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^${prefix}[A-Za-z0-9]+$`).test(value)
  ) {
    throw new RequestError(
      400,
      "invalid_identifier",
      "Invalid provider identifier.",
    );
  }
  return value;
}
function positiveAmount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RequestError(
      409,
      "provider_amount_mismatch",
      "Provider amount is invalid.",
    );
  }
  return value;
}
export class ProviderError extends Error {
  constructor(readonly ambiguous: boolean, readonly safeCode: string) {
    super(safeCode);
  }
}
export interface TransferJob {
  id: string;
  lease_token: string;
  kind: "transfer" | "reversal";
  amount_minor: number;
  currency: string;
  destination: string;
  platform_account_id: string;
  livemode: boolean;
  idempotency_key: string;
  first_attempt_at: string | null;
  transfer_id: string | null;
  transfer_group: string;
}
export interface AccountSnapshot {
  account_id: string;
  charges_enabled: boolean;
  details_submitted: boolean;
  transfers_active: boolean;
  payouts_enabled: boolean;
  requirements_due: string[];
  disabled_reason: string | null;
  country: string | null;
}

export interface ConnectEligibility {
  source: "stripe_country_specs";
  verified_at: string;
  platform_country: string;
  countries: Array<{ country: string; settlement_currencies: string[] }>;
}
// Stripe's self-serve Connect cross-border region, not its much broader
// Country Specs/Global Payouts catalog. Bespoke routes require explicit approval.
const CONNECT_REGIONS = new Set([
  "US",
  "CA",
  "GB",
  "CH",
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IS",
  "IE",
  "IT",
  "LV",
  "LI",
  "LT",
  "LU",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

export class ConnectProvider {
  private verifiedPlatform: JsonObject | null = null;
  private verifiedBalance: JsonObject | null = null;
  private eligible: ConnectEligibility | null = null;
  constructor(
    readonly config: ConnectConfig,
    private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}
  private async request(
    path: string,
    params?: Record<string, string>,
    idempotencyKey?: string,
    account?: string,
  ): Promise<JsonObject> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.secret}`,
      "Stripe-Version": STRIPE_API_VERSION,
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    if (account) headers["Stripe-Account"] = identifier(account, "acct_");
    if (params) headers["Content-Type"] = "application/x-www-form-urlencoded";
    let response: Response;
    try {
      response = await this.fetcher(`https://api.stripe.com/v1/${path}`, {
        method: params ? "POST" : "GET",
        headers,
        body: params ? new URLSearchParams(params) : undefined,
        signal: stripeRequestSignal(),
        redirect: "error",
      });
    } catch {
      throw new ProviderError(true, "provider_outcome_unknown");
    }
    if (!response.ok) {
      let code = "";
      try {
        code = String(object(object(await response.json()).error).code ?? "");
      } catch { /* Never expose raw provider errors or PII. */ }
      throw new ProviderError(
        response.status >= 500 || response.status === 409 ||
          response.status === 429,
        response.status === 402 || code === "balance_insufficient"
          ? "provider_balance_or_account_unavailable"
          : "provider_request_rejected",
      );
    }
    try {
      return object(await response.json());
    } catch {
      throw new ProviderError(true, "provider_response_invalid");
    }
  }
  async verifyPlatform(): Promise<void> {
    const platform = await this.request("account");
    if (platform.id !== this.config.platformAccountId) {
      throw new RequestError(
        409,
        "funding_platform_mismatch",
        "The configured funding platform does not match its API credential.",
      );
    }
    const balance = await this.request("balance");
    if (balance.livemode !== this.config.livemode) {
      throw new RequestError(
        409,
        "funding_mode_mismatch",
        "The configured provider mode does not match its API credential.",
      );
    }
    this.verifiedPlatform = platform;
    this.verifiedBalance = balance;
    this.eligible = null;
  }
  async eligibility(): Promise<ConnectEligibility> {
    if (this.eligible) return this.eligible;
    if (!this.verifiedPlatform) await this.verifyPlatform();
    const country = this.verifiedPlatform!.country;
    if (typeof country !== "string" || !/^[A-Z]{2}$/.test(country)) {
      throw new ProviderError(false, "platform_country_unverified");
    }
    const specs = new Map<string, JsonObject>();
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const list = await this.request(
        `country_specs?limit=100${
          cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""
        }`,
      );
      if (!Array.isArray(list.data)) {
        throw new ProviderError(false, "country_catalog_unavailable");
      }
      for (const raw of list.data) {
        const spec = object(raw);
        if (typeof spec.id !== "string" || !/^[A-Z]{2}$/.test(spec.id)) {
          throw new ProviderError(false, "country_catalog_invalid");
        }
        specs.set(spec.id, spec);
      }
      if (list.has_more !== true) break;
      if (page === 4 || !list.data.length) {
        throw new ProviderError(false, "country_catalog_incomplete");
      }
      cursor = String(object(list.data.at(-1)).id);
    }
    const platformSpec = specs.get(country);
    if (
      !platformSpec || !Array.isArray(platformSpec.supported_transfer_countries)
    ) {
      throw new ProviderError(false, "platform_routes_unavailable");
    }
    const policy = this.config.countryPolicy;
    if (
      policy.type === "connect_cross_border" && !CONNECT_REGIONS.has(country)
    ) {
      throw new ProviderError(false, "platform_cross_border_route_unavailable");
    }
    const approved = policy.type === "domestic"
      ? new Set([country])
      : policy.type === "connect_cross_border"
      ? CONNECT_REGIONS
      : new Set([country, ...(policy.approvedCountries ?? [])]);
    const countries = [...new Set(platformSpec.supported_transfer_countries)]
      .filter((value): value is string =>
        typeof value === "string" && approved.has(value) && specs.has(value)
      )
      .sort().map((code) => {
        const currencies = object(
          specs.get(code)!.supported_bank_account_currencies,
        );
        return {
          country: code,
          settlement_currencies: Object.keys(currencies).filter((value) =>
            /^[a-z]{3}$/.test(value)
          ).map((value) => value.toUpperCase()).sort(),
        };
      }).filter((value) => value.settlement_currencies.length > 0);
    this.eligible = {
      source: "stripe_country_specs",
      verified_at: new Date(this.now()).toISOString(),
      platform_country: country,
      countries,
    };
    return this.eligible;
  }
  async transferCurrencies(account: JsonObject): Promise<string[]> {
    const eligibility = await this.eligibility();
    const route = eligibility.countries.find((entry) =>
      entry.country === account.country
    );
    if (!route) return [];
    // Do not silently convert the frozen commission to a different currency.
    // All configured same-currency balance/bank routes remain available.
    const funded = new Set(
      (Array.isArray(this.verifiedBalance?.available)
        ? this.verifiedBalance!.available
        : [])
        .map((entry: unknown) => String(object(entry).currency).toUpperCase()),
    );
    const configured = new Set<string>();
    if (typeof account.default_currency === "string") {
      configured.add(account.default_currency.toUpperCase());
    }
    let external = object(account.external_accounts ?? {});
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      if (page > 0 || !Array.isArray(external.data)) {
        external = await this.request(
          `accounts/${
            identifier(account.id, "acct_")
          }/external_accounts?limit=100&object=bank_account${
            cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""
          }`,
        );
      }
      if (!Array.isArray(external.data)) {
        throw new ProviderError(false, "recipient_currencies_unavailable");
      }
      for (const entry of external.data) {
        const bank = object(entry);
        if (
          bank.object === "bank_account" && bank.status !== "errored" &&
          bank.status !== "verification_failed" &&
          typeof bank.currency === "string"
        ) configured.add(bank.currency.toUpperCase());
      }
      if (external.has_more !== true) break;
      if (page === 4 || !external.data.length) {
        throw new ProviderError(false, "recipient_currencies_incomplete");
      }
      cursor = String(object(external.data.at(-1)).id);
    }
    return route.settlement_currencies.filter((currency) =>
      funded.has(currency) && configured.has(currency)
    );
  }
  async assertTransferCurrency(
    job: TransferJob,
    account: JsonObject,
  ): Promise<void> {
    if (
      !(await this.transferCurrencies(account)).includes(
        job.currency.toUpperCase(),
      )
    ) {
      throw new RequestError(
        409,
        "transfer_currency_unavailable",
        "This currency needs a verified funding balance and recipient currency route before transfer.",
      );
    }
    if (
      ["ISK", "UGX"].includes(job.currency.toUpperCase()) &&
      job.amount_minor % 100 !== 0
    ) {
      throw new RequestError(
        409,
        "transfer_currency_precision",
        "This currency requires whole-unit amounts in Stripe's API representation.",
      );
    }
  }
  async createAccount(
    affiliateId: string,
    accountKey: string,
    country: string,
    prefill: AccountCreationPrefill = {},
  ): Promise<JsonObject> {
    if (
      !(await this.eligibility()).countries.some((entry) =>
        entry.country === country
      )
    ) {
      throw new RequestError(
        400,
        "country_unavailable",
        "This country is not enabled for creator onboarding.",
      );
    }
    const account = await this.request("accounts", {
      "controller[requirement_collection]": "application",
      "controller[stripe_dashboard][type]": "none",
      "controller[fees][payer]": "application",
      "controller[losses][payments]": "application",
      country,
      "capabilities[transfers][requested]": "true",
      "metadata[kma_affiliate_id]": affiliateId,
      "metadata[kma_platform_account_id]": this.config.platformAccountId,
      "metadata[kma_account_key]": accountKey,
      "business_profile[product_description]": "Creator referral commissions",
      ...accountCreationParams(prefill),
    }, `kma-connect-account:${accountKey}`);
    this.snapshot(
      account,
      identifier(account.id, "acct_"),
      affiliateId,
      accountKey,
    );
    this.assertEmbeddedAccount(account);
    return account;
  }
  async ensureAccount(
    affiliateId: string,
    accountKey: string,
    country: string,
    firstAttemptAt: string,
    prefill: AccountCreationPrefill = {},
  ): Promise<JsonObject> {
    let cursor = "", found: JsonObject | undefined;
    for (let page = 0; page < 20; page++) {
      const list = await this.request(
        `accounts?limit=100${
          cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""
        }`,
      );
      if (!Array.isArray(list.data)) {
        throw new ProviderError(true, "provider_response_invalid");
      }
      for (const raw of list.data) {
        const account = object(raw);
        if (object(account.metadata ?? {}).kma_account_key === accountKey) {
          if (found) {
            throw new RequestError(
              409,
              "multiple_connected_accounts",
              "Account setup needs manual reconciliation.",
            );
          }
          found = account;
        }
      }
      if (!list.has_more) break;
      if (page === 19 || !list.data.length) {
        throw new ProviderError(true, "account_reconciliation_incomplete");
      }
      cursor = String(object(list.data.at(-1)).id);
    }
    if (found) {
      this.snapshot(found, String(found.id), affiliateId, accountKey);
      this.assertEmbeddedAccount(found);
      return found;
    }
    const started = Date.parse(firstAttemptAt);
    if (
      !Number.isFinite(started) || this.now() - started >= 23 * 60 * 60 * 1000
    ) {
      throw new RequestError(
        409,
        "account_reconciliation_required",
        "An earlier account setup needs manual reconciliation before another account can be created.",
      );
    }
    return await this.createAccount(affiliateId, accountKey, country, prefill);
  }
  async account(accountId: string): Promise<JsonObject> {
    return await this.request(`accounts/${identifier(accountId, "acct_")}`);
  }
  snapshot(
    account: JsonObject,
    expectedId: string,
    affiliateId: string,
    accountKey?: string,
  ): AccountSnapshot {
    const metadata = object(account.metadata ?? {});
    if (
      account.id !== expectedId || metadata.kma_affiliate_id !== affiliateId ||
      metadata.kma_platform_account_id !== this.config.platformAccountId ||
      (accountKey && metadata.kma_account_key !== accountKey)
    ) {
      throw new RequestError(
        409,
        "connected_account_mismatch",
        "The connected account does not match this creator.",
      );
    }
    const capabilities = object(account.capabilities ?? {}),
      requirements = object(account.requirements ?? {});
    const due = new Set([
      ...(Array.isArray(requirements.currently_due)
        ? requirements.currently_due
        : []),
      ...(Array.isArray(requirements.past_due) ? requirements.past_due : []),
    ]);
    return {
      account_id: expectedId,
      charges_enabled: account.charges_enabled === true,
      details_submitted: account.details_submitted === true,
      transfers_active: capabilities.transfers === "active",
      payouts_enabled: account.payouts_enabled === true,
      requirements_due: [...due].filter((value): value is string =>
        typeof value === "string"
      ).slice(0, 100),
      disabled_reason: typeof requirements.disabled_reason === "string"
        ? requirements.disabled_reason
        : null,
      country: typeof account.country === "string" ? account.country : null,
    };
  }
  assertEmbeddedAccount(account: JsonObject): void {
    const controller = object(account.controller ?? {});
    if (
      controller.type !== "application" || controller.is_controller !== true ||
      controller.requirement_collection !== "application" ||
      object(controller.stripe_dashboard ?? {}).type !== "none" ||
      object(controller.fees ?? {}).payer !== "application" ||
      object(controller.losses ?? {}).payments !== "application"
    ) {
      throw new RequestError(
        409,
        "embedded_account_incompatible",
        "This existing account cannot use in-app payout setup. An administrator must review its configuration; it has not been replaced.",
      );
    }
  }
  onboardingLink(accountId: string): Promise<string> {
    identifier(accountId, "acct_");
    return Promise.reject(
      new RequestError(
        410,
        "hosted_onboarding_disabled",
        "Open payout setup inside KissMyApps instead.",
      ),
    );
  }
  async onboardingSession(
    accountId: string,
    affiliateId: string,
    accountKey: string,
  ): Promise<{
    client_secret: string;
    expires_at: number;
  }> {
    // KMA authenticates the creator. Re-read ownership and controller settings
    // before granting a session without separate Stripe-user authentication.
    if (!affiliateId || !accountKey) {
      throw new RequestError(
        409,
        "connected_account_mismatch",
        "A verified creator and account binding are required.",
      );
    }
    const account = await this.account(accountId);
    this.snapshot(account, accountId, affiliateId, accountKey);
    this.assertEmbeddedAccount(account);
    const result = await this.request("account_sessions", {
      account: identifier(accountId, "acct_"),
      "components[account_onboarding][enabled]": "true",
      "components[account_onboarding][features][external_account_collection]":
        "true",
      "components[account_onboarding][features][disable_stripe_user_authentication]":
        "true",
    });
    const components = object(result.components ?? {});
    const onboarding = object(components.account_onboarding ?? {});
    const features = object(onboarding.features ?? {});
    if (
      result.object !== "account_session" || result.account !== accountId ||
      result.livemode !== this.config.livemode ||
      typeof result.client_secret !== "string" ||
      !result.client_secret.trim() ||
      typeof result.expires_at !== "number" ||
      !Number.isSafeInteger(result.expires_at) ||
      result.expires_at <= Math.floor(this.now() / 1000) ||
      onboarding.enabled !== true ||
      features.external_account_collection !== true ||
      features.disable_stripe_user_authentication !== true ||
      Object.entries(features).some(([name, value]) =>
        !["external_account_collection", "disable_stripe_user_authentication"]
          .includes(name) && value === true
      ) ||
      Object.entries(components).some(([name, value]) =>
        name !== "account_onboarding" && object(value).enabled === true
      )
    ) throw new ProviderError(false, "provider_session_invalid");
    return {
      client_secret: result.client_secret,
      expires_at: result.expires_at,
    };
  }
  validateJob(job: TransferJob): void {
    if (
      job.platform_account_id !== this.config.platformAccountId ||
      job.livemode !== this.config.livemode
    ) {
      throw new RequestError(
        409,
        "transfer_scope_mismatch",
        "Transfer funding scope does not match configuration.",
      );
    }
    identifier(job.destination, "acct_");
    positiveAmount(job.amount_minor);
    if (
      !/^[A-Za-z]{3}$/.test(job.currency) ||
      !["transfer", "reversal"].includes(job.kind) || !job.idempotency_key ||
      job.idempotency_key.length > 255 || !job.transfer_group
    ) {
      throw new RequestError(
        409,
        "transfer_job_invalid",
        "Approved transfer details are invalid.",
      );
    }
    if (job.kind === "reversal") identifier(job.transfer_id, "tr_");
  }
  private matchesTransfer(transfer: JsonObject, job: TransferJob): void {
    if (
      transfer.destination !== job.destination ||
      transfer.livemode !== job.livemode ||
      String(transfer.currency).toUpperCase() !== job.currency.toUpperCase() ||
      (job.kind === "transfer" &&
        (transfer.amount !== job.amount_minor ||
          transfer.transfer_group !== job.transfer_group ||
          object(transfer.metadata ?? {}).kma_job_id !== job.id))
    ) {
      throw new RequestError(
        409,
        "transfer_evidence_mismatch",
        "Provider transfer does not match the approved request.",
      );
    }
  }
  async transfer(id: string): Promise<JsonObject> {
    return await this.request(`transfers/${identifier(id, "tr_")}`);
  }
  async payout(id: string, accountId: string): Promise<JsonObject> {
    return await this.request(
      `payouts/${identifier(id, "po_")}`,
      undefined,
      undefined,
      accountId,
    );
  }
  async charge(id: string): Promise<JsonObject> {
    return await this.request(`charges/${identifier(id, "ch_")}`);
  }
  async dispute(id: string): Promise<JsonObject> {
    return await this.request(`disputes/${identifier(id, "dp_")}`);
  }
  async execute(
    job: TransferJob,
    allowMutation = true,
    beforeMutation?: () => Promise<TransferJob>,
  ): Promise<{ provider_id: string; reconciled: boolean }> {
    this.validateJob(job);
    // Search before every mutation, including the first lease after a worker crash.
    const path = job.kind === "transfer"
      ? `transfers?${new URLSearchParams({
        transfer_group: job.transfer_group,
        destination: job.destination,
        limit: "100",
      })}`
      : `transfers/${job.transfer_id}/reversals?limit=100`;
    let cursor = "", found: JsonObject | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.request(
        path + (cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""),
      );
      if (!Array.isArray(result.data)) {
        throw new ProviderError(true, "provider_response_invalid");
      }
      for (const raw of result.data) {
        const entry = object(raw);
        if (object(entry.metadata ?? {}).kma_job_id === job.id) {
          if (found) {
            throw new RequestError(
              409,
              "multiple_provider_objects",
              "Multiple provider records require manual reconciliation.",
            );
          }
          found = entry;
        }
      }
      if (!result.has_more) break;
      if (page === 19 || result.data.length === 0) {
        throw new ProviderError(true, "provider_reconciliation_incomplete");
      }
      cursor = String(object(result.data.at(-1)).id);
    }
    if (found) {
      if (job.kind === "transfer") this.matchesTransfer(found, job);
      else {
        const original = await this.transfer(job.transfer_id!);
        this.matchesTransfer(original, job);
        if (
          found.amount !== job.amount_minor ||
          found.transfer !== job.transfer_id ||
          String(found.currency).toUpperCase() !== job.currency.toUpperCase()
        ) {
          throw new RequestError(
            409,
            "reversal_evidence_mismatch",
            "Provider reversal does not match its approved request.",
          );
        }
      }
      return {
        provider_id: identifier(
          found.id,
          job.kind === "transfer" ? "tr_" : "trr_",
        ),
        reconciled: true,
      };
    }
    if (!allowMutation) {
      throw new RequestError(
        404,
        "provider_receipt_pending",
        "No matching provider receipt is available yet.",
      );
    }
    if (job.kind === "reversal") {
      const original = await this.transfer(job.transfer_id!);
      this.matchesTransfer(original, job);
      if (
        typeof original.amount !== "number" ||
        typeof original.amount_reversed !== "number" ||
        original.amount - original.amount_reversed < job.amount_minor
      ) {
        throw new RequestError(
          409,
          "reversal_balance_mismatch",
          "Transfer reversal needs manual reconciliation.",
        );
      }
    }
    const inRetryWindow = (value: string | null) => {
      const firstAttempt = value ? Date.parse(value) : this.now();
      return Number.isFinite(firstAttempt) &&
        this.now() - firstAttempt < 23 * 60 * 60 * 1000;
    };
    // Stripe may discard v1 idempotency keys after 24h. Never recreate an ambiguous
    // money movement after that window merely because it is absent from a search.
    if (!inRetryWindow(job.first_attempt_at)) {
      throw new RequestError(
        409,
        "manual_reconciliation_required",
        "The provider retry window has expired; review this request before proceeding.",
      );
    }
    if (beforeMutation) {
      // The lease becomes a possible-money-movement attempt only after all
      // read-only preflight and receipt lookups. Never reset an earlier attempt.
      const current = await beforeMutation();
      for (
        const key of [
          "id",
          "lease_token",
          "kind",
          "amount_minor",
          "currency",
          "destination",
          "platform_account_id",
          "livemode",
          "idempotency_key",
          "transfer_id",
          "transfer_group",
        ] as const
      ) {
        if (current[key] !== job[key]) {
          throw new RequestError(
            409,
            "transfer_lease_changed",
            "The approved transfer changed before provider submission.",
          );
        }
      }
      if (
        !current.first_attempt_at || !inRetryWindow(current.first_attempt_at) ||
        (job.first_attempt_at &&
          current.first_attempt_at !== job.first_attempt_at)
      ) {
        throw new RequestError(
          409,
          "manual_reconciliation_required",
          "The provider retry window requires reconciliation.",
        );
      }
      job = { ...job, first_attempt_at: current.first_attempt_at };
    }
    let result: JsonObject;
    if (job.kind === "transfer") {
      result = await this.request("transfers", {
        amount: String(job.amount_minor),
        currency: job.currency.toLowerCase(),
        destination: job.destination,
        transfer_group: job.transfer_group,
        "metadata[kma_job_id]": job.id,
      }, job.idempotency_key);
      this.matchesTransfer(result, job);
    } else {
      result = await this.request(`transfers/${job.transfer_id}/reversals`, {
        amount: String(job.amount_minor),
        "metadata[kma_job_id]": job.id,
      }, job.idempotency_key);
      if (
        result.amount !== job.amount_minor ||
        result.transfer !== job.transfer_id ||
        String(result.currency).toUpperCase() !== job.currency.toUpperCase()
      ) {
        throw new RequestError(
          409,
          "reversal_evidence_mismatch",
          "Provider reversal does not match the approved request.",
        );
      }
    }
    return {
      provider_id: identifier(
        result.id,
        job.kind === "transfer" ? "tr_" : "trr_",
      ),
      reconciled: false,
    };
  }
}

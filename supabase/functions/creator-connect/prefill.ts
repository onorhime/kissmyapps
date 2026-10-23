// Only the service-side reservation supplies this snapshot. Never accept profile
// or identity fields from the Account Session request/browser.
export interface AccountCreationPrefill {
  email?: string;
  business_type?: "individual" | "company";
  company_name?: string;
  website_url?: string;
}

export function accountCreationPrefill(value: unknown): AccountCreationPrefill {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const result: AccountCreationPrefill = {};
  const text = (value: unknown, max: number) =>
    typeof value === "string" && value.trim().length > 0 &&
      value.trim().length <= max &&
      [...value].every((character) =>
        character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127
      )
      ? value.trim()
      : undefined;
  const email = text(input.email, 254);
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) result.email = email;
  if (["individual", "company"].includes(String(input.business_type))) {
    result.business_type = input.business_type as "individual" | "company";
  }
  const name = text(input.company_name, 160);
  if (result.business_type === "company" && name) result.company_name = name;
  const website = text(input.website_url, 500);
  if (website) {
    try {
      const url = new URL(website);
      if (url.protocol === "https:" && !url.username && !url.password) {
        result.website_url = website;
      }
    } catch {
      /* Invalid legacy optional profile fields are not sent to Stripe. */
    }
  }
  return result;
}

export function accountCreationParams(value: unknown): Record<string, string> {
  const prefill = accountCreationPrefill(value);
  return {
    ...(prefill.email ? { email: prefill.email } : {}),
    ...(prefill.business_type ? { business_type: prefill.business_type } : {}),
    ...(prefill.company_name ? { "company[name]": prefill.company_name } : {}),
    ...(prefill.website_url
      ? { "business_profile[url]": prefill.website_url }
      : {}),
  };
}

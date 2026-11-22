export interface Account {
  provider: "meta" | "tiktok";
  account_id: string;
  currency: string;
  credential: string;
}
type Row = { day: string; campaign: string; amount: number };
type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_report");
  }
  return value as Json;
}
async function get(
  url: URL,
  headers: Record<string, string>,
  fetcher: typeof fetch,
): Promise<Json> {
  const res = await fetcher(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? "authorization_failed"
        : "provider_unavailable",
    );
  }
  return object(await res.json());
}

/** Read all pages before replacing any managed cost rows. Provider pagination never supplies a destination URL. */
export async function readSpend(
  account: Account,
  from: string,
  through: string,
  metaVersion: string,
  fetcher = fetch,
): Promise<Row[]> {
  if (
    !/^\d+$/.test(account.account_id) || !/^[A-Z]{3}$/.test(account.currency)
  ) throw new Error("account_configuration");
  const sums = new Map<string, Row>();
  function add(day: unknown, campaign: unknown, amount: unknown) {
    if (
      typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      day < from || day > through ||
      typeof campaign !== "string" || !campaign.trim() ||
      campaign.trim().length > 200 ||
      (typeof amount !== "string" && typeof amount !== "number") ||
      !/^\d+(\.\d{1,6})?$/.test(String(amount))
    ) throw new Error("invalid_report");
    const name = campaign.trim(),
      key = JSON.stringify([day, name]),
      value = (sums.get(key)?.amount ?? 0) + Math.round(Number(amount) * 1e6);
    if (!Number.isSafeInteger(value)) throw new Error("invalid_report");
    sums.set(key, { day, campaign: name, amount: value });
  }
  const all = () =>
    Array.from(sums.values(), (r) => ({ ...r, amount: r.amount / 1e6 }));
  const seen = new Set<string>();
  let after = "";
  for (let page = 1; page <= 100; page++) {
    if (account.provider === "meta") {
      if (!/^v\d+\.\d+$/.test(metaVersion)) {
        throw new Error("meta_version_required");
      }
      const url = new URL(
        `https://graph.facebook.com/${metaVersion}/act_${account.account_id}/insights`,
      );
      url.search = new URLSearchParams({
        level: "campaign",
        fields: "date_start,campaign_name,account_currency,spend",
        time_increment: "1",
        time_range: JSON.stringify({ since: from, until: through }),
        limit: "500",
        ...(after ? { after } : {}),
      }).toString();
      const body = await get(url, {
        Authorization: "Bearer " + account.credential,
      }, fetcher);
      if (!Array.isArray(body.data)) throw new Error("invalid_report");
      for (const item of body.data) {
        const r = object(item);
        if (r.account_currency !== account.currency) {
          throw new Error("currency_mismatch");
        }
        add(r.date_start, r.campaign_name, r.spend);
      }
      const paging = body.paging ? object(body.paging) : {};
      if (!paging.next) return all();
      const cursor = object(paging.cursors).after;
      if (typeof cursor !== "string" || !cursor || seen.has(cursor)) {
        throw new Error("invalid_pagination");
      }
      seen.add(cursor);
      after = cursor;
    } else {
      const url = new URL(
        "https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/",
      );
      url.search = new URLSearchParams({
        advertiser_id: account.account_id,
        report_type: "BASIC",
        data_level: "AUCTION_CAMPAIGN",
        dimensions: '["campaign_id","stat_time_day"]',
        metrics: '["spend","campaign_name","currency"]',
        start_date: from,
        end_date: through,
        page: String(page),
        page_size: "1000",
      }).toString();
      const body = await get(
        url,
        { "Access-Token": account.credential },
        fetcher,
      );
      if (body.code !== 0) throw new Error("provider_rejected");
      const data = object(body.data), paging = object(data.page_info);
      if (
        !Array.isArray(data.list) || !Number.isInteger(paging.total_page) ||
        Number(paging.total_page) < 0 || Number(paging.page) !== page
      ) throw new Error("invalid_report");
      for (const item of data.list) {
        const row = object(item),
          dim = object(row.dimensions),
          metric = object(row.metrics);
        if (metric.currency !== account.currency) {
          throw new Error("currency_mismatch");
        }
        add(
          String(dim.stat_time_day).slice(0, 10),
          metric.campaign_name,
          metric.spend,
        );
      }
      if (page >= Number(paging.total_page)) return all();
    }
  }
  throw new Error("report_too_large");
}

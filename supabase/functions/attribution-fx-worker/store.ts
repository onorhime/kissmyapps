// The database function of the exchange-rate worker, read field by field.
// Every assumption about attribution_fx_store lives in this file: the RPC
// argument name, the input shape and the answer.
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { isPlainObject } from "../_shared/validation.ts";
import type { EcbRate } from "./ecb.ts";

type Json = Record<string, unknown>;

export const FX_STORE_FUNCTION = "attribution_fx_store";
export const RPC_ARGUMENT = "p_input";
/** The most rates the function takes in one call. */
export const MAXIMUM_RATES_PER_CALL = 20_000;

export interface FxStored {
  stored: number;
  /** The newest day the database has a rate for, any currency. */
  latestDay: string | null;
}

export interface FxStore {
  save(rates: EcbRate[]): Promise<FxStored>;
}

/** What attribution_fx_store is asked. */
export function storeInput(rates: EcbRate[]): Json {
  return {
    rates: rates.map(({ day, currency, per_eur }) => ({
      day,
      currency,
      per_eur,
    })),
  };
}

export function parseStored(value: unknown): FxStored {
  if (
    !isPlainObject(value) || typeof value.stored !== "number" ||
    !Number.isSafeInteger(value.stored) || value.stored < 0
  ) throw new DatabaseBoundaryError();
  const latest = value.latest_day ?? null;
  if (
    latest !== null &&
    (typeof latest !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(latest))
  ) throw new DatabaseBoundaryError();
  return { stored: value.stored, latestDay: latest };
}

export function databaseFxStore(): FxStore {
  const client = serviceClient(30_000);
  return {
    save: async (rates) => {
      const { data, error } = await client.rpc(FX_STORE_FUNCTION, {
        [RPC_ARGUMENT]: storeInput(rates),
      });
      if (error) throw new DatabaseBoundaryError(error.code);
      return parseStored(data);
    },
  };
}

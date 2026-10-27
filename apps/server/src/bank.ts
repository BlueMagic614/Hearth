import { createHash } from 'node:crypto';
import { CountryCode, Configuration, PlaidApi, PlaidEnvironments, Products, type Transaction as PlaidTxn } from 'plaid';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import type { Cents } from '@hearth/core';

/**
 * The bank-data provider, kept behind a small interface so Plaid can be swapped (SimpleFIN fallback) and so
 * tests run against a fake bank. All amounts here follow Hearth's convention: money in is positive, money out negative.
 */
export interface BankAccount {
  externalId: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  current: Cents | null;
  available: Cents | null;
  limit: Cents | null;
}

export interface BankTxn {
  externalId: string;
  accountExternalId: string;
  date: string;
  authorizedDate: string | null;
  amount: Cents;
  name: string;
  merchantName: string | null;
  pending: boolean;
  pendingExternalId: string | null;
  category: string | null;
}

export interface SyncPage {
  added: BankTxn[];
  modified: BankTxn[];
  removed: string[];
  nextCursor: string;
  hasMore: boolean;
}

export interface BankProvider {
  readonly environment: 'sandbox' | 'production' | 'fake';
  /** With accessToken, opens Link in update mode to repair a connection whose Kemba sign-in expired. */
  createLinkToken(opts: { userId: string; webhookUrl?: string; accessToken?: string }): Promise<string>;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  getAccounts(accessToken: string): Promise<BankAccount[]>;
  syncTransactions(accessToken: string, cursor: string | null): Promise<SyncPage>;
  refresh(accessToken: string): Promise<void>;
  removeItem(accessToken: string): Promise<void>;
  /** Verifies the Plaid-Verification JWT on a webhook against the raw request body. */
  verifyWebhook(rawBody: string, jwt: string | undefined): Promise<boolean>;
}

const cents = (n: number | null | undefined): Cents | null => (n === null || n === undefined ? null : Math.round(n * 100));

export function toBankTxn(t: PlaidTxn): BankTxn {
  return {
    externalId: t.transaction_id,
    accountExternalId: t.account_id,
    date: t.date,
    authorizedDate: t.authorized_date ?? null,
    // Plaid: positive = money out of the account. Hearth: negative = money out.
    amount: -Math.round(t.amount * 100),
    name: t.name,
    merchantName: t.merchant_name ?? null,
    pending: t.pending,
    pendingExternalId: t.pending_transaction_id ?? null,
    category: t.personal_finance_category?.detailed ?? t.personal_finance_category?.primary ?? null,
  };
}

export class PlaidProvider implements BankProvider {
  private api: PlaidApi;
  private keyCache = new Map<string, { jwk: Record<string, unknown>; at: number }>();

  constructor(readonly environment: 'sandbox' | 'production', clientId: string, secret: string) {
    this.api = new PlaidApi(new Configuration({
      basePath: PlaidEnvironments[environment],
      baseOptions: { headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret, 'Plaid-Version': '2020-09-14' } },
    }));
  }

  async createLinkToken({ userId, webhookUrl, accessToken }: { userId: string; webhookUrl?: string; accessToken?: string }) {
    const r = await this.api.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: 'Hearth',
      ...(accessToken ? { access_token: accessToken } : { products: [Products.Transactions], transactions: { days_requested: 365 } }),
      country_codes: [CountryCode.Us],
      language: 'en',
      webhook: webhookUrl,
    });
    return r.data.link_token;
  }

  async exchangePublicToken(publicToken: string) {
    const r = await this.api.itemPublicTokenExchange({ public_token: publicToken });
    return { accessToken: r.data.access_token, itemId: r.data.item_id };
  }

  async getAccounts(accessToken: string): Promise<BankAccount[]> {
    const r = await this.api.accountsGet({ access_token: accessToken });
    return r.data.accounts.map((a) => ({
      externalId: a.account_id,
      name: a.official_name || a.name,
      mask: a.mask ?? null,
      type: String(a.type),
      subtype: a.subtype ? String(a.subtype) : null,
      current: cents(a.balances.current),
      available: cents(a.balances.available),
      limit: cents(a.balances.limit),
    }));
  }

  async syncTransactions(accessToken: string, cursor: string | null): Promise<SyncPage> {
    const r = await this.api.transactionsSync({ access_token: accessToken, cursor: cursor ?? undefined, count: 500 });
    return {
      added: r.data.added.map(toBankTxn),
      modified: r.data.modified.map(toBankTxn),
      removed: r.data.removed.map((x) => x.transaction_id).filter((x): x is string => !!x),
      nextCursor: r.data.next_cursor,
      hasMore: r.data.has_more,
    };
  }

  async refresh(accessToken: string) {
    await this.api.transactionsRefresh({ access_token: accessToken });
  }

  async removeItem(accessToken: string) {
    await this.api.itemRemove({ access_token: accessToken });
  }

  async verifyWebhook(rawBody: string, jwt: string | undefined): Promise<boolean> {
    if (!jwt) return false;
    try {
      const header = decodeProtectedHeader(jwt);
      if (header.alg !== 'ES256' || !header.kid) return false;
      let cached = this.keyCache.get(header.kid);
      if (!cached || Date.now() - cached.at > 24 * 3600_000) {
        const r = await this.api.webhookVerificationKeyGet({ key_id: header.kid });
        cached = { jwk: r.data.key as unknown as Record<string, unknown>, at: Date.now() };
        this.keyCache.set(header.kid, cached);
      }
      const key = await importJWK(cached.jwk, 'ES256');
      const { payload } = await jwtVerify(jwt, key, { maxTokenAge: '5 min' });
      const bodyHash = createHash('sha256').update(rawBody).digest('hex');
      return payload.request_body_sha256 === bodyHash;
    } catch {
      return false;
    }
  }
}

/** Builds the provider from environment variables. Production keys win once they exist; null when Plaid isn't configured. */
export function bankFromEnv(env = process.env): BankProvider | null {
  const id = env.PLAID_CLIENT_ID;
  if (!id) return null;
  const want = (env.PLAID_ENV as 'sandbox' | 'production' | undefined) ?? (env.PLAID_SECRET_PRODUCTION ? 'production' : 'sandbox');
  const secret = want === 'production' ? env.PLAID_SECRET_PRODUCTION : env.PLAID_SECRET_SANDBOX;
  if (!secret) return null;
  return new PlaidProvider(want, id, secret);
}

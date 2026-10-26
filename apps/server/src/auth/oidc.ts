/**
 * OIDC relying party (openid-client v6): authorization code + PKCE (S256) + state + nonce.
 * Tokens never reach the browser. Role = highest role mapped from the groups claim; no mapped group
 * means the login is refused.
 */
import * as oidc from 'openid-client';
import { ROLE_RANK, type Role } from '@rconsole/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../store/db.ts';
import { hashToken, randomToken } from '../store/sessions.ts';

export const FLOW_TTL_MS = 10 * 60_000;

export interface OidcIdentity {
  sub: string;
  username: string;
  displayName: string;
  groups: string[];
  role: Role | null;
}

export class OidcError extends Error {
  readonly code: 'oidc_failed' | 'oidc_state' | 'oidc_no_role';
  constructor(code: OidcError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export function mapRole(groups: readonly string[], mapping: Record<string, Role>): Role | null {
  let best: Role | null = null;
  // Own keys only: group names come from the IdP, and "constructor" or "__proto__" must not hit Object.prototype.
  const lookup = (k: string): Role | undefined => (Object.hasOwn(mapping, k) ? mapping[k] : undefined);
  for (const g of groups) {
    const r = lookup(g) ?? lookup(g.replace(/^\//, ''));
    if (r && (best === null || ROLE_RANK[r] > ROLE_RANK[best])) best = r;
  }
  return best;
}

function groupsFrom(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').slice(0, 500);
  if (typeof v === 'string') return [v];
  return [];
}

export class OidcService {
  readonly #cfg: NonNullable<AppConfig['oidc']>;
  readonly #redirectUri: string;
  readonly #db: Db;
  #config: Promise<oidc.Configuration> | undefined;
  #lastError: string | undefined;

  constructor(cfg: NonNullable<AppConfig['oidc']>, publicOrigin: string, db: Db) {
    this.#cfg = cfg;
    this.#redirectUri = `${publicOrigin}/api/v1/auth/oidc/callback`;
    this.#db = db;
  }

  get redirectUri() {
    return this.#redirectUri;
  }
  get lastError() {
    return this.#lastError;
  }

  /** Discovery is lazy and retried after failures (the IdP may start after us). */
  configuration(): Promise<oidc.Configuration> {
    if (!this.#config) {
      const opts: oidc.DiscoveryRequestOptions = { timeout: 10 };
      if (this.#cfg.allowInsecureHttpIssuer && this.#cfg.issuer.startsWith('http:')) opts.execute = [oidc.allowInsecureRequests];
      this.#config = oidc
        .discovery(new URL(this.#cfg.issuer), this.#cfg.clientId, undefined, oidc.ClientSecretBasic(this.#cfg.clientSecret.reveal()), opts)
        .then((c) => {
          this.#lastError = undefined;
          return c;
        })
        .catch((e: unknown) => {
          this.#config = undefined;
          this.#lastError = (e as Error).message;
          throw e;
        });
    }
    return this.#config;
  }

  /** Create a login flow. Returns the IdP URL and the browser-binding value for the flow cookie. */
  async start(): Promise<{ url: string; binding: string }> {
    const config = await this.configuration();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const binding = randomToken(32);
    const now = Date.now();
    this.#db.prepare('DELETE FROM oidc_flows WHERE created_at < ?').run(now - FLOW_TTL_MS);
    this.#db
      .prepare('INSERT INTO oidc_flows (state_hash, binding_hash, nonce, code_verifier, created_at) VALUES (?,?,?,?,?)')
      .run(hashToken(state), hashToken(binding), nonce, verifier, now);
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.#redirectUri,
      scope: this.#cfg.scopes.join(' '),
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url: url.href, binding };
  }

  /** Complete the flow. `query` is the raw callback query string. */
  async callback(query: string, binding: string | undefined): Promise<OidcIdentity> {
    const params = new URLSearchParams(query);
    const state = params.get('state');
    if (!state || !binding) throw new OidcError('oidc_state', 'missing state or flow cookie');
    const row = this.#db.prepare('SELECT * FROM oidc_flows WHERE state_hash = ?').get(hashToken(state)) as
      | { state_hash: string; binding_hash: string; nonce: string; code_verifier: string; created_at: number }
      | undefined;
    // Single use, regardless of the outcome.
    this.#db.prepare('DELETE FROM oidc_flows WHERE state_hash = ?').run(hashToken(state));
    if (!row || row.binding_hash !== hashToken(binding) || Date.now() - row.created_at > FLOW_TTL_MS) {
      throw new OidcError('oidc_state', 'unknown, expired or foreign login flow');
    }
    if (params.get('error')) throw new OidcError('oidc_failed', `IdP returned error ${params.get('error')!.slice(0, 64)}`);
    const config = await this.configuration();
    const currentUrl = new URL(`${this.#redirectUri}?${query}`);
    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: row.code_verifier,
        expectedState: state,
        expectedNonce: row.nonce,
        idTokenExpected: true,
      });
    } catch (e) {
      throw new OidcError('oidc_failed', `token exchange failed: ${(e as Error).message}`);
    }
    const claims = tokens.claims();
    if (!claims) throw new OidcError('oidc_failed', 'no ID token');
    let groups = groupsFrom(claims[this.#cfg.groupsClaim]);
    let profile: Record<string, unknown> = claims;
    if (!(this.#cfg.groupsClaim in claims)) {
      try {
        const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
        groups = groupsFrom(info[this.#cfg.groupsClaim]);
        profile = { ...info, ...claims };
      } catch {
        /* no userinfo: no groups */
      }
    }
    const username = String(profile[this.#cfg.usernameClaim] ?? claims.sub).slice(0, 128);
    const displayName = String(profile.name ?? username).slice(0, 128);
    const id: OidcIdentity = { sub: claims.sub, username, displayName, groups, role: mapRole(groups, this.#cfg.roleMapping) };
    return id;
  }

  /**
   * IdP logout URL for the browser to navigate to. Identifies the client with `client_id` and an approved
   * `post_logout_redirect_uri` only: no `id_token_hint`, because that would hand the ID token (an identity
   * assertion with personal claims) to the browser and its history (review L1). The IdP may ask the user to
   * confirm the logout.
   */
  async endSessionUrl(postLogout: string): Promise<string | undefined> {
    if (!this.#cfg.rpInitiatedLogout) return undefined;
    try {
      const config = await this.configuration();
      if (!config.serverMetadata().end_session_endpoint) return undefined;
      return oidc.buildEndSessionUrl(config, { post_logout_redirect_uri: postLogout, client_id: this.#cfg.clientId }).href;
    } catch {
      return undefined;
    }
  }
}

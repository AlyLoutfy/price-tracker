import { createHash, randomBytes } from 'node:crypto';
import { asicsProductCode, parseAsicsProduct, type ProductSnapshot } from './parsers/asics';

// Public storefront settings published by ASICS' production JavaScript bundle. This client ID
// identifies its anonymous shop app; it is not a private API key or a personal ASICS account.
const API = 'https://y841ero5.api.commercecloud.salesforce.com';
const ORGANIZATION = 'f_ecom_bbtn_prd';
const CLIENT_ID = '32c40d28-93fc-4889-a473-14543e1cbcb5';
const CALLBACK = 'https://www.asics.com/callback';
const AUTH = `${API}/shopper/auth/v1/organizations/${ORGANIZATION}/oauth2`;

/** Use an anonymous guest session, exactly as the storefront does. Never persist guest tokens. */
export function createAsicsCollector(request: typeof fetch = fetch): (url: string) => Promise<ProductSnapshot> {
  let session: { token: string; expiresAt: number } | undefined;

  async function guestToken(): Promise<string> {
    if (session && session.expiresAt > Date.now() + 60_000) return session.token;
    const verifier = randomBytes(48).toString('base64url');
    const parameters = new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: CALLBACK, response_type: 'code', hint: 'guest',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    const auth = await request(`${AUTH}/authorize?${parameters}`, {
      redirect: 'manual', signal: AbortSignal.timeout(30_000),
    });
    const location = auth.headers.get('location');
    if (auth.status !== 303 || !location) throw new Error(`ASICS guest authorization failed: HTTP ${auth.status}`);
    const callback = new URL(location);
    const code = callback.searchParams.get('code');
    if (`${callback.origin}${callback.pathname}` !== CALLBACK || !code) {
      throw new Error('ASICS guest authorization returned an unexpected callback');
    }
    const response = await request(`${AUTH}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code_pkce', client_id: CLIENT_ID, channel_id: 'asics-eu',
        redirect_uri: CALLBACK, code, code_verifier: verifier, usid: callback.searchParams.get('usid') ?? '',
      }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`ASICS guest token failed: HTTP ${response.status}`);
    const data = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('ASICS: no guest token returned');
    session = { token: data.access_token, expiresAt: Date.now() +
      (typeof data.expires_in === 'number' ? data.expires_in : 300) * 1000 };
    return session.token;
  }

  return async (sourceUrl) => {
    const code = asicsProductCode(sourceUrl);
    const parameters = new URLSearchParams({
      siteId: 'asics-eu', locale: 'fr-FR', currency: 'EUR', expand: 'availability,prices,variations',
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await guestToken();
      const response = await request(`${API}/product/shopper-products/v1/organizations/${ORGANIZATION}/products/${code}?${parameters}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 && attempt === 0) { session = undefined; continue; }
      if (!response.ok) throw new Error(`ASICS product request failed: HTTP ${response.status}`);
      return parseAsicsProduct(await response.json(), sourceUrl);
    }
    throw new Error('ASICS: anonymous session expired');
  };
}

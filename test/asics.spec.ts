import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/asics-product.json';
import { createAsicsCollector } from '../src/asics';
import { isAsicsProductUrl, parseAsicsProduct } from '../src/parsers/asics';

const url = 'https://www.asics.com/fr/fr-fr/gel-venture-6/p/1203A297-002.html?size=9&width=Standard';
const selected = (data: typeof fixture) => data.variants.find((v) => v.variationValues.size === '9')!;

describe('ASICS product parser', () => {
  it('reads the requested colour, size, width, price and stock from the live API fixture', () => {
    expect(parseAsicsProduct(fixture, url)).toEqual({
      key: 'asics:1203A297-002:4550457173490', title: 'GEL-VENTURE 6',
      price: 100, currency: 'EUR', inStock: true, size: '9', sizeLabel: '42.5',
      width: 'Standard', color: 'Black/Black',
    });
  });

  it('reads size-level discounts and stock independently of the colour-level price', () => {
    const data = structuredClone(fixture);
    selected(data).price = 79.95;
    selected(data).orderable = false;
    expect(parseAsicsProduct(data, url)).toMatchObject({ price: 79.95, inStock: false });
  });

  it('rejects a missing size, wrong width, or wrong colour without guessing', () => {
    const data = structuredClone(fixture);
    selected(data).variationValues.size = '99';
    expect(() => parseAsicsProduct(data, url)).toThrow(/no quote/);
    expect(() => parseAsicsProduct(fixture, url.replace('Standard', 'Wide'))).toThrow(/no quote/);
    expect(() => parseAsicsProduct({ ...fixture, variationValues: { color: '1203A297.022' } }, url)).toThrow(/colour mismatch/);
  });

  it.each([0, -1, 'not a price', null])('rejects invalid price %s', (price) => {
    const data = structuredClone(fixture);
    Object.assign(selected(data), { price });
    expect(() => parseAsicsProduct(data, url)).toThrow(/invalid EUR price/);
  });

  it('rejects unknown currency, identity, stock, or an error response', () => {
    expect(() => parseAsicsProduct({ ...fixture, currency: 'USD' }, url)).toThrow(/EUR/);
    expect(() => parseAsicsProduct({ ...fixture, id: 'other-product' }, url)).toThrow(/identity/);
    const data = structuredClone(fixture);
    Object.assign(selected(data), { orderable: undefined });
    expect(() => parseAsicsProduct(data, url)).toThrow(/stock/);
    expect(() => parseAsicsProduct({ fault: 'denied' }, url)).toThrow(/identity/);
  });

  it('requires an ASICS France product with an explicit size and width', () => {
    expect(isAsicsProductUrl(url)).toBe(true);
    expect(isAsicsProductUrl(url.replace('fr/fr-fr', 'us/en-us'))).toBe(false);
    expect(isAsicsProductUrl(url.replace('www.asics.com', 'evil-asics.com'))).toBe(false);
    expect(isAsicsProductUrl(url.split('?')[0]!)).toBe(false);
  });
});

const authorization = () => new Response(null, {
  status: 303, headers: { location: 'https://www.asics.com/callback?code=guest-code&usid=guest-id' },
});
const token = () => Response.json({ access_token: 'anonymous-test-token', expires_in: 1800 });

describe('ASICS anonymous storefront API', () => {
  it('uses PKCE, requests France/EUR prices, and reuses one guest session for all products', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(authorization()).mockResolvedValueOnce(token())
      .mockResolvedValueOnce(Response.json(fixture)).mockResolvedValueOnce(Response.json(fixture));
    const collect = createAsicsCollector(request);
    expect((await collect(url)).price).toBe(100);
    await collect(url);
    expect(request).toHaveBeenCalledTimes(4);
    const authorizeUrl = new URL(String(request.mock.calls[0]![0]));
    const form = request.mock.calls[1]![1]!.body as URLSearchParams;
    expect(authorizeUrl.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(form.get('code_verifier')!).digest('base64url'));
    expect(form.get('grant_type')).toBe('authorization_code_pkce');
    expect(form.get('channel_id')).toBe('asics-eu');
    const productUrl = new URL(String(request.mock.calls[2]![0]));
    expect(productUrl.searchParams.get('locale')).toBe('fr-FR');
    expect(productUrl.searchParams.get('currency')).toBe('EUR');
  });

  it('refreshes an expired guest session once', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(authorization()).mockResolvedValueOnce(token())
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(authorization()).mockResolvedValueOnce(token())
      .mockResolvedValueOnce(Response.json(fixture));
    expect((await createAsicsCollector(request)(url)).price).toBe(100);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it('rejects failed authorization or an unexpected callback before requesting a token', async () => {
    const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    await expect(createAsicsCollector(denied)(url)).rejects.toThrow(/authorization failed/);
    const redirect = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 303, headers: { location: 'https://other.example/callback?code=guest' },
    }));
    await expect(createAsicsCollector(redirect)(url)).rejects.toThrow(/unexpected callback/);
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});

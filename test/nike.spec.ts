import { describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/nike-product.json';
import { createNikeCollector } from '../src/nike';
import { isNikeProductUrl, parseNikeProduct } from '../src/parsers/nike';

// Captured from the live feed on 19 November 2026: on sale at 71.99 EUR, with EU 43 out of stock.
const url = 'https://www.nike.com/fr/t/chaussures-nike-dunk-low-retro-pour-homme-GeHBr62V/HF5441-105?size=43';
const info = (data: typeof fixture) => data.objects[0]!.productInfo[0]!;
const skuId = (eu: string) =>
  info(fixture).skus.find((sku) => sku.countrySpecifications.some((spec) => spec.localizedSize === eu))!.id;
const stock = (data: typeof fixture, eu: string) =>
  info(data).availableSkus.find((entry) => entry.skuId === skuId(eu))!;

describe('Nike product parser', () => {
  it('reads the colour price and the requested EU size stock from the live feed fixture', () => {
    expect(parseNikeProduct(fixture, url)).toEqual({
      key: 'nike:HF5441-105:22e958a0-e03b-5333-9977-95aeb8de00a3', title: 'Nike Dunk Low Retro',
      price: 71.99, currency: 'EUR', inStock: false, color: 'Blanc/Blanc/Light Smoke Grey',
      size: '43', sizeLabel: '43', store: 'Nike France',
    });
    expect(parseNikeProduct(fixture, url.replace('size=43', 'size=42.5'))).toMatchObject({
      key: `nike:HF5441-105:${skuId('42.5')}`, inStock: true,
    });
  });

  it('follows a restock of the requested size only', () => {
    const data = structuredClone(fixture);
    stock(data, '43').available = true;
    stock(data, '42.5').available = false;
    expect(parseNikeProduct(data, url).inStock).toBe(true);
  });

  it('rejects a size the colour is not made in, another colour, or an empty feed', () => {
    expect(() => parseNikeProduct(fixture, url.replace('size=43', 'size=52'))).toThrow(/no EU 52/);
    expect(() => parseNikeProduct(fixture, url.replace('HF5441-105', 'HF5441-100'))).toThrow(/no product/);
    expect(() => parseNikeProduct({ pages: { totalResources: 0 }, objects: [] }, url)).toThrow(/no product/);
  });

  it.each([0, -1, 'not a price', null])('rejects invalid price %s', (price) => {
    const data = structuredClone(fixture);
    Object.assign(info(data).merchPrice, { currentPrice: price });
    expect(() => parseNikeProduct(data, url)).toThrow(/invalid EUR price/);
  });

  it('rejects a price outside France or EUR, and an unknown stock status', () => {
    const data = structuredClone(fixture);
    info(data).merchPrice.currency = 'USD';
    expect(() => parseNikeProduct(data, url)).toThrow(/France\/EUR/);
    const us = structuredClone(fixture);
    info(us).merchPrice.country = 'US';
    expect(() => parseNikeProduct(us, url)).toThrow(/France\/EUR/);
    const unknown = structuredClone(fixture);
    Object.assign(stock(unknown, '43'), { available: undefined });
    expect(() => parseNikeProduct(unknown, url)).toThrow(/unknown stock/);
  });

  it('requires a Nike France product link with an EU size', () => {
    expect(isNikeProductUrl(url)).toBe(true);
    expect(isNikeProductUrl(url.replace('size=43', 'size=42.5'))).toBe(true);
    expect(isNikeProductUrl(url.split('?')[0]!)).toBe(false);
    expect(isNikeProductUrl(url.replace('size=43', 'size=L'))).toBe(false);
    expect(isNikeProductUrl(url.replace('/fr/', '/us/'))).toBe(false);
    expect(isNikeProductUrl(url.replace('www.nike.com', 'nike.com.example'))).toBe(false);
    expect(isNikeProductUrl(url.replace('/HF5441-105', ''))).toBe(false);
  });
});

describe('Nike product feed', () => {
  it('asks the Nike.com France feed for the exact style colour', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture));
    expect(await createNikeCollector(request)(url)).toMatchObject({ price: 71.99, inStock: false });
    const feed = new URL(String(request.mock.calls[0]![0]));
    expect(`${feed.origin}${feed.pathname}`).toBe('https://api.nike.com/product_feed/threads/v2');
    expect(feed.searchParams.getAll('filter')).toEqual([
      'marketplace(FR)', 'language(fr)', 'channelId(d9a5bc42-4b9c-4976-858a-f159cf99c647)',
      'productInfo.merchProduct.styleColor(HF5441-105)',
    ]);
  });

  it('fails on an HTTP error or a block page instead of guessing', async () => {
    const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response('Access Denied', { status: 403 }));
    await expect(createNikeCollector(denied)(url)).rejects.toThrow(/HTTP 403/);
    const blocked = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Access Denied</html>'));
    await expect(createNikeCollector(blocked)(url)).rejects.toThrow(/did not return JSON/);
  });
});

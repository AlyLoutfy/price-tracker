import { describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/zara-product.json';
import { createZaraCollector } from '../src/zara';
import { isZaraProductUrl, parseZaraProduct } from '../src/parsers/zara';

// Captured from the live site on 21 November 2026: nine colours at 2,590 EGP, none on sale.
const url = 'https://www.zara.com/eg/en/comfort-textured-chino-trousers-p00706650.html?v1=545470298';
const colour = (data: typeof fixture, productId: number) =>
  data.product.detail.colors.find((entry) => entry.productId === productId)!;

describe('Zara product parser', () => {
  it("reads the linked colour's EGP price and the sizes in stock from the live fixture", () => {
    expect(parseZaraProduct(fixture, url)).toEqual({
      key: 'zara:545470298', title: 'COMFORT TEXTURED CHINO TROUSERS', price: 2590, currency: 'EGP',
      inStock: true, color: 'Anthracite Grey', sizesInStock: ['36', '38', '40', '42', '44', '46', '48'],
      store: 'Zara Egypt',
    });
  });

  it('picks the colour named by v1 and lists only its available sizes', () => {
    const white = parseZaraProduct(fixture, url.replace('545470298', '545470288'));
    expect(white).toMatchObject({ key: 'zara:545470288', color: 'White', inStock: true });
    expect(white.sizesInStock).toHaveLength(6);
  });

  it('reads a sale price in minor units, and is out of stock until any size is back', () => {
    const data = structuredClone(fixture);
    const linked = colour(data, 545470298);
    linked.pricing.price.value = 181300;
    for (const size of linked.sizes) size.availability = 'out_of_stock';
    expect(parseZaraProduct(data, url)).toMatchObject({ price: 1813, inStock: false, sizesInStock: [] });
    linked.sizes[2]!.availability = 'low_on_stock';
    expect(parseZaraProduct(data, url)).toMatchObject({ inStock: true, sizesInStock: ['40'] });
  });

  it('rejects a colour not on the page, or a page without product data', () => {
    expect(() => parseZaraProduct(fixture, url.replace('545470298', '111111111'))).toThrow(/no colour 111111111/);
    expect(() => parseZaraProduct({ noIndex: true }, url)).toThrow(/no colour/);
  });

  it.each([0, -1, 'not a price', null])('rejects invalid price %s', (value) => {
    const data = structuredClone(fixture);
    Object.assign(colour(data, 545470298).pricing.price, { value });
    expect(() => parseZaraProduct(data, url)).toThrow(/invalid EGP price/);
  });

  it('rejects another currency, a hidden price, or unknown stock', () => {
    const euro = structuredClone(fixture);
    colour(euro, 545470298).pricing.price.currency.code = 'EUR';
    expect(() => parseZaraProduct(euro, url)).toThrow(/missing EGP price/);
    const hidden = structuredClone(fixture);
    colour(hidden, 545470298).priceUnavailable = true;
    expect(() => parseZaraProduct(hidden, url)).toThrow(/invalid EGP price/);
    const unknown = structuredClone(fixture);
    Object.assign(colour(unknown, 545470298).sizes[0]!, { availability: undefined });
    expect(() => parseZaraProduct(unknown, url)).toThrow(/unknown stock/);
  });

  it('requires a Zara Egypt product link with its colour', () => {
    expect(isZaraProductUrl(url)).toBe(true);
    expect(isZaraProductUrl(`${url}&v2=2432096&origin=shopcart`)).toBe(true);
    expect(isZaraProductUrl(url.split('?')[0]!)).toBe(false);
    expect(isZaraProductUrl(url.replace('/eg/en/', '/es/en/'))).toBe(false);
    expect(isZaraProductUrl(url.replace('www.zara.com', 'zara.com.example'))).toBe(false);
  });
});

describe('Zara product page data', () => {
  it('asks for the JSON of the same page and colour, without the cart parameters', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture));
    expect(await createZaraCollector(request)(`${url}&v2=2432096&origin=shopcart`)).toMatchObject({ price: 2590 });
    expect(String(request.mock.calls[0]![0])).toBe(
      'https://www.zara.com/eg/en/comfort-textured-chino-trousers-p00706650.html?v1=545470298&ajax=true');
  });

  it('fails on an HTTP error or a bot check instead of guessing', async () => {
    const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response('Access Denied', { status: 403 }));
    await expect(createZaraCollector(denied)(url)).rejects.toThrow(/HTTP 403/);
    const check = vi.fn<typeof fetch>().mockResolvedValue(new Response('<!DOCTYPE html><meta http-equiv="refresh">'));
    await expect(createZaraCollector(check)(url)).rejects.toThrow(/did not return JSON/);
  });
});

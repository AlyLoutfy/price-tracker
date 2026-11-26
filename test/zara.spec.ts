import { describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/zara-product.json';
import jumperFixture from './fixtures/zara-jumper.json';
import saleFixture from './fixtures/zara-chino-sale.json';
import { createZaraCollector } from '../src/zara';
import { isZaraProductUrl, parseZaraProduct, zaraSize } from '../src/parsers/zara';

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

// Captured from the live site on 26 November 2026: the jumper's S and M sold out, L and XL in stock;
// the chinos' Light beige reduced from 2,590 to 1,550 EGP for Black Friday, every size sold out.
describe('Zara size watch', () => {
  const jumper = 'https://www.zara.com/eg/en/brushed-effect-argyle-jumper-p05755112.html?v1=554794390';
  const beige = 'https://www.zara.com/eg/en/comfort-textured-chino-trousers-p00706650.html?v1=551275789';

  it('reads only the size named in the link, and opens Zara’s own link in alerts', () => {
    expect(parseZaraProduct(jumperFixture, `${jumper}&size=M`)).toEqual({
      key: 'zara:554794390:554779439', title: 'BRUSHED-EFFECT ARGYLE JUMPER', price: 2590, currency: 'EGP',
      inStock: false, color: 'Grey / Blue', size: 'M', sizesInStock: ['L', 'XL'], store: 'Zara Egypt',
      pageUrl: jumper,
    });
    expect(parseZaraProduct(jumperFixture, `${jumper}&size=L`)).toMatchObject({ size: 'L', inStock: true });
  });

  it('matches the size as Zara names it, whatever the case or spacing in the link', () => {
    expect(zaraSize(`${jumper}&size=%20m%20`)).toBe('m');
    expect(parseZaraProduct(jumperFixture, `${jumper}&size=%20m%20`)).toMatchObject({ size: 'M' });
    expect(zaraSize(jumper)).toBeUndefined();
  });

  it('marks a size Zara says is low on stock', () => {
    const data = structuredClone(jumperFixture);
    data.product.detail.colors[0]!.sizes[1]!.availability = 'low_on_stock';
    expect(parseZaraProduct(data, `${jumper}&size=M`)).toMatchObject({ inStock: true, lowStock: true });
  });

  it('fails loudly for a size the colour does not come in, listing the ones it does', () => {
    expect(() => parseZaraProduct(jumperFixture, `${jumper}&size=XXL`))
      .toThrow('Zara: no size XXL in Grey / Blue; it comes in S, M, L, XL');
    expect(isZaraProductUrl(`${jumper}&size=`)).toBe(false);
  });

  it('reads a sale price with the crossed-out full price, for the size or the whole colour', () => {
    expect(parseZaraProduct(saleFixture, `${beige}&size=38`)).toMatchObject({
      key: 'zara:551275789:551253801', price: 1550, oldPrice: 2590, inStock: false, size: '38', sizesInStock: [],
    });
    expect(parseZaraProduct(saleFixture, beige)).toMatchObject({ price: 1550, oldPrice: 2590, inStock: false });
    expect(parseZaraProduct(saleFixture, beige.replace('551275789', '545470298'))).not.toHaveProperty('oldPrice');
  });

  it('asks Zara for the colour only: the size is picked from its reply', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(jumperFixture));
    expect(await createZaraCollector(request)(`${jumper}&size=M`)).toMatchObject({ size: 'M', inStock: false });
    expect(String(request.mock.calls[0]![0])).toBe(`${jumper}&ajax=true`);
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

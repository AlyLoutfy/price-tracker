import type { ProductSnapshot } from '../types';

/**
 * A Zara Egypt product link; its `v1` parameter names the colour. Every size of it is watched,
 * unless you add the one to watch as `&size=38` (Zara's own size name: 38, M, XL…).
 */
export function isZaraProductUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const size = url.searchParams.get('size');
    return url.protocol === 'https:' && ['www.zara.com', 'zara.com'].includes(url.hostname) &&
      /^\/eg\/en\/[^/]+-p\d{8}\.html$/.test(url.pathname) && /^\d+$/.test(url.searchParams.get('v1') ?? '') &&
      (size === null || size.trim() !== '');
  } catch { return false; }
}

/** The colour's product id: the link's `v1` parameter. */
export function zaraColorId(sourceUrl: string): number {
  if (!isZaraProductUrl(sourceUrl)) throw new Error('Zara: unsupported product URL');
  return Number(new URL(sourceUrl).searchParams.get('v1'));
}

/** The one size the link watches (`&size=M`), or undefined when it watches the whole colour. */
export function zaraSize(sourceUrl: string): string | undefined {
  if (!isZaraProductUrl(sourceUrl)) throw new Error('Zara: unsupported product URL');
  return new URL(sourceUrl).searchParams.get('size')?.trim() || undefined;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const objects = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(object) : []);
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/** Sizes a shopper can put in the basket now. */
const BUYABLE = new Set(['in_stock', 'low_on_stock']);

/** Parse the data Zara's site loads for a product page: the linked colour's price and stock. */
export function parseZaraProduct(data: unknown, sourceUrl: string): ProductSnapshot {
  const colorId = zaraColorId(sourceUrl);
  const product = object(data) && object(data.product) ? data.product : {};
  const detail = object(product.detail) ? product.detail : {};
  const color = objects(detail.colors).find((entry) => entry.productId === colorId);
  if (!color) throw new Error(`Zara: no colour ${colorId} on Zara Egypt`);
  const pricing = object(color.pricing) && object(color.pricing.price) ? color.pricing.price : {};
  const currency = object(pricing.currency) ? pricing.currency : {};
  // Prices come in minor units: 199000 with exponent -2 is 1,990.00 EGP.
  if (currency.code !== 'EGP' || typeof currency.exponent !== 'number' || currency.exponent > 0) {
    throw new Error('Zara: missing EGP price');
  }
  const exponent = currency.exponent;
  const egp = (minor: unknown) => (typeof minor === 'number' ? Math.round(minor / 10 ** -exponent * 100) / 100 : NaN);
  const price = color.priceUnavailable !== true ? egp(pricing.value) : NaN;
  if (!Number.isFinite(price) || price <= 0) throw new Error('Zara: missing/invalid EGP price');
  // During a sale Zara shows the full price crossed out next to the reduced one.
  const oldPrice = egp(color.oldPrice);
  const sizes = objects(color.sizes);
  if (!sizes.length || sizes.some((size) => typeof size.availability !== 'string')) {
    throw new Error('Zara: unknown stock status');
  }
  const name = (size: JsonObject) => String(size.name);
  const buyable = (size: JsonObject) => BUYABLE.has(size.availability as string);
  const colorName = text(color.name) ?? String(colorId);
  const snapshot: ProductSnapshot = {
    key: `zara:${colorId}`, title: text(product.name) ?? `Zara ${colorId}`,
    price, currency: 'EGP', inStock: sizes.some(buyable),
    color: colorName, sizesInStock: sizes.filter(buyable).map(name), store: 'Zara Egypt',
    ...(oldPrice > price ? { oldPrice } : {}),
  };
  const wanted = zaraSize(sourceUrl);
  if (wanted === undefined) return snapshot;
  const size = sizes.find((entry) => name(entry).trim().toUpperCase() === wanted.toUpperCase());
  if (!size) throw new Error(`Zara: no size ${wanted} in ${colorName}; it comes in ${sizes.map(name).join(', ')}`);
  // Open Zara's own link in alerts: the size parameter is ours, not the site's.
  const page = new URL(sourceUrl);
  page.searchParams.delete('size');
  return {
    ...snapshot, key: `zara:${colorId}:${String(size.sku ?? name(size))}`, size: name(size),
    inStock: buyable(size), ...(size.availability === 'low_on_stock' ? { lowStock: true } : {}),
    pageUrl: page.toString(),
  };
}

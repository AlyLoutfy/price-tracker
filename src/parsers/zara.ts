import type { ProductSnapshot } from '../types';

/** A Zara Egypt product link; its `v1` parameter names the colour. Every size of it is watched. */
export function isZaraProductUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['www.zara.com', 'zara.com'].includes(url.hostname) &&
      /^\/eg\/en\/[^/]+-p\d{8}\.html$/.test(url.pathname) && /^\d+$/.test(url.searchParams.get('v1') ?? '');
  } catch { return false; }
}

/** The colour's product id: the link's `v1` parameter. */
export function zaraColorId(sourceUrl: string): number {
  if (!isZaraProductUrl(sourceUrl)) throw new Error('Zara: unsupported product URL');
  return Number(new URL(sourceUrl).searchParams.get('v1'));
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
  const price = typeof pricing.value === 'number' && color.priceUnavailable !== true
    ? pricing.value / 10 ** -currency.exponent : NaN;
  if (!Number.isFinite(price) || price <= 0) throw new Error('Zara: missing/invalid EGP price');
  const sizes = objects(color.sizes);
  if (!sizes.length || sizes.some((size) => typeof size.availability !== 'string')) {
    throw new Error('Zara: unknown stock status');
  }
  const sizesInStock = sizes
    .filter((size) => typeof size.availability === 'string' && BUYABLE.has(size.availability))
    .map((size) => String(size.name));
  return {
    key: `zara:${colorId}`, title: text(product.name) ?? `Zara ${colorId}`,
    price: Math.round(price * 100) / 100, currency: 'EGP', inStock: sizesInStock.length > 0,
    color: text(color.name) ?? String(colorId), sizesInStock, store: 'Zara Egypt',
  };
}

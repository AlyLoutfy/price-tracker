import type { ProductSnapshot } from '../types';

/**
 * A Nike France product link for one colour, with the EU size to watch added as `?size=43`: Nike's
 * own links carry no size, and its site ignores the extra parameter.
 */
export function isNikeProductUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['www.nike.com', 'nike.com'].includes(url.hostname) &&
      /^\/fr\/t\/[^/]+\/[A-Z0-9]+-\d{3}$/.test(url.pathname) &&
      /^\d+(?:\.\d+)?$/.test(url.searchParams.get('size') ?? '');
  } catch { return false; }
}

/** The style colour, e.g. "HF5441-105": the last part of the link's path. */
export function nikeStyleColor(sourceUrl: string): string {
  if (!isNikeProductUrl(sourceUrl)) throw new Error('Nike: unsupported product URL');
  return new URL(sourceUrl).pathname.split('/').pop()!;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const objects = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(object) : []);

/** Parse Nike's public product feed: the colour's French price, and the stock of one EU size. */
export function parseNikeProduct(data: unknown, sourceUrl: string): ProductSnapshot {
  const styleColor = nikeStyleColor(sourceUrl);
  const size = new URL(sourceUrl).searchParams.get('size')!;
  const product = (object(data) ? objects(data.objects) : [])
    .flatMap((thread) => objects(thread.productInfo))
    .find((info) => object(info.merchProduct) && info.merchProduct.styleColor === styleColor);
  if (!product || !object(product.merchPrice)) throw new Error(`Nike: no product ${styleColor} on Nike France`);
  const merchPrice = product.merchPrice;
  const content = object(product.productContent) ? product.productContent : {};
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  if (merchPrice.currency !== 'EUR' || merchPrice.country !== 'FR') {
    throw new Error('Nike: missing France/EUR price');
  }
  const price = typeof merchPrice.currentPrice === 'number' || typeof merchPrice.currentPrice === 'string'
    ? Number(merchPrice.currentPrice) : NaN;
  if (!Number.isFinite(price) || price <= 0) throw new Error('Nike: missing/invalid EUR price');
  // Nike prices a colour as a whole; stock is per size.
  const sku = objects(product.skus).find((entry) => objects(entry.countrySpecifications).some((spec) =>
    spec.country === 'FR' && spec.localizedSizePrefix === 'EU' && spec.localizedSize === size));
  if (!sku || typeof sku.id !== 'string') throw new Error(`Nike: no EU ${size} for ${styleColor}`);
  const stock = objects(product.availableSkus).find((entry) => entry.skuId === sku.id);
  if (typeof stock?.available !== 'boolean') throw new Error(`Nike: unknown stock status for EU ${size}`);
  return {
    key: `nike:${styleColor}:${sku.id}`, title: text(content.title) ?? `Nike ${styleColor}`,
    price: Math.round(price * 100) / 100, currency: 'EUR', inStock: stock.available,
    color: text(content.colorDescription) ?? styleColor, size, sizeLabel: size, store: 'Nike France',
  };
}

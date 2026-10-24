/** Exact colour, size and width requested by an ASICS France product link. */
export interface ProductSnapshot {
  readonly key: string;
  readonly title: string;
  readonly price: number;
  readonly currency: 'EUR';
  readonly inStock: boolean;
  readonly color: string;
  readonly size: string;
  readonly sizeLabel: string;
  readonly width: string;
}

export function isAsicsProductUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['www.asics.com', 'asics.com'].includes(url.hostname) &&
      /^\/fr\/fr-fr\/[^/]+\/p\/[A-Z0-9]+-\d{3}\.html$/.test(url.pathname) &&
      /^\d+(?:\.\d+)?$/.test(url.searchParams.get('size') ?? '') &&
      Boolean(url.searchParams.get('width'));
  } catch { return false; }
}

export function asicsProductCode(sourceUrl: string): string {
  if (!isAsicsProductUrl(sourceUrl)) throw new Error('ASICS: unsupported product URL');
  return new URL(sourceUrl).pathname.split('/').pop()!.replace(/\.html$/, '');
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Parse the public Shopper Products response used by the ASICS storefront itself. */
export function parseAsicsProduct(data: unknown, sourceUrl: string): ProductSnapshot {
  const code = asicsProductCode(sourceUrl);
  const url = new URL(sourceUrl);
  const size = url.searchParams.get('size')!;
  const width = url.searchParams.get('width')!;
  if (!object(data) || data.id !== code || data.currency !== 'EUR' ||
      typeof data.name !== 'string' || !object(data.variationValues)) {
    throw new Error('ASICS: missing product identity or EUR currency');
  }
  const color = code.replace(/-(\d{3})$/, '.$1');
  if (data.variationValues.color !== color) throw new Error('ASICS: product colour mismatch');
  const variants = Array.isArray(data.variants) ? data.variants.filter(object) : [];
  const selected = variants.find((variant) => object(variant.variationValues) &&
    variant.variationValues.color === color && String(variant.variationValues.size) === size &&
    variant.variationValues.width === width);
  if (!selected) throw new Error(`ASICS: no quote for ${code}, size ${size}, width ${width}`);
  const price = typeof selected.price === 'number' || typeof selected.price === 'string'
    ? Number(selected.price) : NaN;
  if (!Number.isFinite(price) || price <= 0) throw new Error('ASICS: missing/invalid EUR price');
  if (typeof selected.orderable !== 'boolean' || typeof selected.productId !== 'string') {
    throw new Error('ASICS: unknown variant identity or stock status');
  }
  const attributes = Array.isArray(data.variationAttributes) ? data.variationAttributes.filter(object) : [];
  const label = (id: string, value: string): string => {
    const attribute = attributes.find((attribute) => attribute.id === id);
    const values = Array.isArray(attribute?.values) ? attribute.values.filter(object) : [];
    const found = values.find((entry) => entry.value === value);
    return typeof found?.name === 'string' ? found.name : value;
  };
  return {
    key: `asics:${code}:${selected.productId}`, title: data.name,
    price: Math.round(price * 100) / 100, currency: 'EUR', inStock: selected.orderable,
    color: label('color', color), size, sizeLabel: label('size', size), width,
  };
}

import type { Currency, ProductSnapshot, TrackerConfig } from './types';
import type { SeenState } from './state';
import { describeError, type TrackOutcome } from './track';
import { escapeHtml } from './notifier';

export interface ProductDeps {
  readonly collect: (url: string) => Promise<ProductSnapshot>;
  readonly send: (html: string, options?: { preview?: boolean }) => Promise<void>;
}

/** "71.99 EUR"; EGP as Zara Egypt shows it, without piastres when there are none: "1,990 EGP". */
function money(amount: number, currency: Currency): string {
  if (currency === 'EUR') return `${amount.toFixed(2)} EUR`;
  const digits = Number.isInteger(amount) ? 0 : 2;
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${currency}`;
}

/** The watched size as shoppers see it: "EU 42.5 · Standard" (ASICS), "EU 43" (Nike), "M" (Zara). */
function sizeName(product: ProductSnapshot): string | undefined {
  if (product.sizeLabel) return `EU ${product.sizeLabel}${product.width ? ` · ${product.width}` : ''}`;
  return product.size;
}

/** The watched size and whether it can be bought, or every size available for a whole-colour watch. */
function stockLine(product: ProductSnapshot): string {
  const size = sizeName(product);
  if (!size) return `In stock: ${escapeHtml((product.sizesInStock ?? []).join(' · '))}`;
  const status = !product.inStock ? 'Sold out' : product.lowStock ? 'Only a few left' : 'In stock';
  return `Size ${escapeHtml(size)} · ${status}`;
}

/** "<s>2,590 EGP</s> → <b>1,550 EGP</b> (40.2% off)" below the full price, or just the price. */
function priceLine(product: ProductSnapshot, full = product.oldPrice): string {
  const price = (amount: number) => money(amount, product.currency);
  if (full === undefined || Math.round(product.price * 100) >= Math.round(full * 100)) {
    return `<b>${price(product.price)}</b>`;
  }
  const percent = Math.round((1 - product.price / full) * 1000) / 10;
  return `<s>${price(full)}</s> → <b>${price(product.price)}</b> (${percent}% off)`;
}

const storeLink = (tracker: TrackerConfig, product: ProductSnapshot) =>
  `<a href="${escapeHtml(product.pageUrl ?? tracker.url)}">Open on ${escapeHtml(product.store)}</a>`;

export function formatDiscountMessage(tracker: TrackerConfig, product: ProductSnapshot, reference: number): string {
  const price = (amount: number) => money(amount, product.currency);
  return [
    '🏷️ <b>Price Tracker — Discount</b>',
    `<b>${escapeHtml(product.title)}</b>`,
    escapeHtml(product.color),
    stockLine(product),
    priceLine(product, reference),
    `Save ${price(Math.round((reference - product.price) * 100) / 100)}`,
    storeLink(tracker, product),
  ].join('\n');
}

/** The alert a stock watch exists for: its size can be bought now. */
export function formatStockMessage(tracker: TrackerConfig, product: ProductSnapshot): string {
  return [
    '✅ <b>Price Tracker — In stock</b>',
    `<b>${escapeHtml(product.title)}</b>`,
    escapeHtml(product.color),
    stockLine(product),
    priceLine(product),
    storeLink(tracker, product),
  ].join('\n');
}

/** Sent once when a stock watch starts on a sold-out size, so you know it is running. */
export function formatWatchingMessage(tracker: TrackerConfig, product: ProductSnapshot): string {
  const others = product.sizesInStock?.filter((size) => size !== product.size);
  return [
    '👀 <b>Price Tracker — Now watching</b>',
    `<b>${escapeHtml(product.title)}</b>`,
    escapeHtml(product.color),
    stockLine(product),
    priceLine(product),
    others === undefined ? '' : others.length
      ? `Other sizes in stock: ${escapeHtml(others.join(' · '))}` : 'Every size is sold out right now.',
    `You’ll get a message here when size ${escapeHtml(sizeName(product) ?? '')} is back in stock.`,
    storeLink(tracker, product),
  ].filter(Boolean).join('\n');
}

/** A quiet baseline; one alert for a sale, further drops, or a new sale after full price returns. */
export async function trackProduct(tracker: TrackerConfig, state: SeenState, deps: ProductDeps): Promise<TrackOutcome> {
  let product: ProductSnapshot;
  try { product = await deps.collect(tracker.url); }
  catch (error) {
    const message = describeError(error);
    console.warn(`⚠️  ${tracker.id}: ${message}`);
    return { kind: 'failed', matches: 0, sent: 0, sendFailures: 0, error: message };
  }
  const entry = state[tracker.id];
  const previous = entry?.url === tracker.url ? entry.product : undefined;
  const reference = tracker.referencePrice!;
  // An edited reference starts a fresh sale comparison, just like an edited URL.
  let alertedPrice = previous?.referencePrice === reference ? previous.alertedPrice : undefined;
  const discounted = Math.round(product.price * 100) < Math.round(reference * 100);
  if (!discounted) alertedPrice = undefined;
  let sent = 0;
  let sendFailures = 0;
  if (discounted && product.inStock &&
      (alertedPrice === undefined || Math.round(product.price * 100) < Math.round(alertedPrice * 100))) {
    try {
      await deps.send(formatDiscountMessage(tracker, product, reference), { preview: false });
      alertedPrice = product.price;
      sent = 1;
    } catch (error) {
      sendFailures = 1;
      console.warn(`⚠️  discount alert failed for ${tracker.id}: ${(error as Error).message}`);
    }
  }
  state[tracker.id] = {
    url: tracker.url, keys: [product.key], product: {
      price: product.price, referencePrice: reference, currency: product.currency,
      inStock: product.inStock, checkedAt: new Date().toISOString(),
      ...(alertedPrice === undefined ? {} : { alertedPrice }),
    },
  };
  const sizes = product.sizesInStock?.length ? ` (${product.sizesInStock.join(', ')})` : '';
  console.log(`✓ ${tracker.id}: ${money(product.price, product.currency)} (reference ${money(reference, product.currency)}), ` +
    `${product.inStock ? 'in stock' : 'out of stock'}${sizes}, ${sent} discount alert(s)`);
  return { kind: previous ? 'diff' : 'seed', matches: 1, sent, sendFailures };
}

/**
 * Watch one size for coming back in stock, at any price. A new watch says so once: the alert itself
 * when the size is available, otherwise a "now watching" note. Then one alert each time the size
 * becomes available — retried until delivered — and nothing while it sells out again.
 */
export async function trackStock(tracker: TrackerConfig, state: SeenState, deps: ProductDeps): Promise<TrackOutcome> {
  let product: ProductSnapshot;
  try { product = await deps.collect(tracker.url); }
  catch (error) {
    const message = describeError(error);
    console.warn(`⚠️  ${tracker.id}: ${message}`);
    return { kind: 'failed', matches: 0, sent: 0, sendFailures: 0, error: message };
  }
  const entry = state[tracker.id];
  const previous = entry?.url === tracker.url ? entry.stock : undefined;
  // Selling out again re-arms the alert: the next restock is news again.
  let alerted = product.inStock && (previous?.alerted ?? false);
  let sent = 0;
  let sendFailures = 0;
  if (product.inStock ? !alerted : previous === undefined) {
    try {
      await deps.send(product.inStock ? formatStockMessage(tracker, product) : formatWatchingMessage(tracker, product),
        { preview: false });
      alerted = product.inStock;
      sent = 1;
    } catch (error) {
      sendFailures = 1;
      console.warn(`⚠️  stock message failed for ${tracker.id}: ${(error as Error).message}`);
      // Left unrecorded, the watch starts afresh next run and sends its "now watching" note again.
      if (!product.inStock) return { kind: 'seed', matches: 1, sent, sendFailures };
    }
  }
  state[tracker.id] = {
    url: tracker.url, keys: [product.key], stock: {
      inStock: product.inStock, price: product.price, currency: product.currency,
      checkedAt: new Date().toISOString(), alerted,
    },
  };
  const status = !product.inStock ? 'sold out' : product.lowStock ? 'low on stock' : 'in stock';
  const others = product.sizesInStock ? `; in stock: ${product.sizesInStock.join(', ') || 'no size'}` : '';
  console.log(`✓ ${tracker.id}: size ${sizeName(product)} ${status} at ${money(product.price, product.currency)}` +
    `${others}, ${sent} message(s)`);
  return { kind: previous ? 'diff' : 'seed', matches: 1, sent, sendFailures };
}

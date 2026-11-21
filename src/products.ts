import type { Currency, ProductSnapshot, TrackerConfig } from './types';
import type { SeenState } from './state';
import type { TrackOutcome } from './track';
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

/** The watched size, or every size available when the whole colour is watched. */
function stockLine(product: ProductSnapshot): string {
  if (!product.sizeLabel) return `In stock: ${escapeHtml((product.sizesInStock ?? []).join(' · '))}`;
  return `Size EU ${escapeHtml(product.sizeLabel)}${product.width ? ` · ${escapeHtml(product.width)}` : ''} · In stock`;
}

export function formatDiscountMessage(tracker: TrackerConfig, product: ProductSnapshot, reference: number): string {
  const percent = Math.round((1 - product.price / reference) * 1000) / 10;
  const price = (amount: number) => money(amount, product.currency);
  return [
    '🏷️ <b>Price Tracker — Discount</b>',
    `<b>${escapeHtml(product.title)}</b>`,
    escapeHtml(product.color),
    stockLine(product),
    `<s>${price(reference)}</s> → <b>${price(product.price)}</b> (${percent}% off)`,
    `Save ${price(Math.round((reference - product.price) * 100) / 100)}`,
    `<a href="${escapeHtml(tracker.url)}">Open on ${escapeHtml(product.store)}</a>`,
  ].join('\n');
}

/** A quiet baseline; one alert for a sale, further drops, or a new sale after full price returns. */
export async function trackProduct(tracker: TrackerConfig, state: SeenState, deps: ProductDeps): Promise<TrackOutcome> {
  let product: ProductSnapshot;
  try { product = await deps.collect(tracker.url); }
  catch (error) {
    console.warn(`⚠️  ${tracker.id}: ${(error as Error).message}`);
    return { kind: 'failed', matches: 0, sent: 0, sendFailures: 0 };
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

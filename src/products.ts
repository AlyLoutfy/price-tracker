import type { TrackerConfig } from './types';
import type { ProductSnapshot } from './parsers/asics';
import type { SeenState } from './state';
import type { TrackOutcome } from './track';
import { escapeHtml } from './notifier';

export interface ProductDeps {
  readonly collect: (url: string) => Promise<ProductSnapshot>;
  readonly send: (html: string, options?: { preview?: boolean }) => Promise<void>;
}

const eur = (amount: number) => `${amount.toFixed(2)} EUR`;

export function formatDiscountMessage(tracker: TrackerConfig, product: ProductSnapshot, reference: number): string {
  const percent = Math.round((1 - product.price / reference) * 1000) / 10;
  return [
    '🏷️ <b>Price Tracker — Discount</b>',
    `<b>${escapeHtml(product.title)}</b>`,
    escapeHtml(product.color),
    `Size EU ${escapeHtml(product.sizeLabel)} · ${escapeHtml(product.width)} · In stock`,
    `<s>${eur(reference)}</s> → <b>${eur(product.price)}</b> (${percent}% off)`,
    `Save ${eur(Math.round((reference - product.price) * 100) / 100)}`,
    `<a href="${escapeHtml(tracker.url)}">Open on ASICS France</a>`,
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
  console.log(`✓ ${tracker.id}: ${eur(product.price)} (reference ${eur(reference)}), ${product.inStock ? 'in stock' : 'out of stock'}, ${sent} discount alert(s)`);
  return { kind: previous ? 'diff' : 'seed', matches: 1, sent, sendFailures };
}

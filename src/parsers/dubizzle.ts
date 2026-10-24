import type { Listing, ParsedPage } from '../types';
import { extractAssignedJson, slugToTitle } from './helpers';

// A Dubizzle results page carries its result set three times over, in decreasing richness. We use
// all three, because each covers a gap in the others:
//
// 1. `window.state` — the app state the page hydrates from. Its `algolia.content.hits` hold every
//    ad on the page in full: price, the seller's description, structured fields (year, mileage,
//    storage…) with English labels, cover photo, and the total page count. The only source of the
//    description, which the tax and battery checks read.
// 2. schema.org JSON-LD — an ItemList with each ad's price, title and thumbnail. Stable because
//    search engines consume it, so it's the fallback if the app state ever changes shape.
// 3. The analytics arrays "ad_ids":[...], "ad_ids_set_2":[...], … — every ad id on the page, even
//    ones neither of the above described. The safety net that guarantees we never miss a listing.
//
// One listing per id from the union of all three, keyed on the stable numeric id. An id only (3)
// knows about still becomes a listing, with a null price and description — which every filter lets
// through, so it is surfaced rather than silently dropped.

const SITE = 'https://www.dubizzle.com.eg';
const AD_IDS_ARRAY = /"ad_ids(?:_set_\d+)?":\[([^\]]*)\]/gi;
const JSON_LD = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const ID_IN_URL = /-ID(\d+)\.html/;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
const asText = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim() || undefined
    : undefined;
const asPrice = (value: unknown): number | undefined => {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : undefined;
};

/**
 * A Latin display title from the ad's make/model/year ("Seat Leon 2022", "Apple - iPhone 17").
 *
 * Deliberately not the seller's own headline: roughly a third of Egyptian ads are titled in Arabic
 * ("سيات ليون 2024"), and a `titleMustInclude: ["leon"]` filter would drop every one of them.
 */
function structuredTitle(parts: ReadonlyArray<string | undefined>): string | undefined {
  const present = parts.filter(Boolean);
  return present.length ? present.join(' ') : undefined;
}

// ── Layer 1: window.state ──────────────────────────────────────────────────────────────────────

interface AppState {
  readonly listings: Map<string, Listing>;
  readonly totalPages?: number;
  readonly explicitlyEmpty: boolean;
}

function listingFromHit(hit: Json): Listing | undefined {
  const id = asText(hit.externalID);
  if (!id) return undefined;

  const attributes: Record<string, string> = {};
  for (const field of asArray(hit.formattedExtraFields)) {
    if (!isObject(field)) continue;
    const label = asText(field.name_l1);
    const value = asText(field.formattedValue_l1);
    if (label && value && field.attribute !== 'price') attributes[label] = value;
  }

  const extra = isObject(hit.extraFields) ? hit.extraFields : {};
  const cover = isObject(hit.coverPhoto) ? asText(hit.coverPhoto.id) : undefined;
  const description = asText(hit.description);

  return {
    key: `dubizzle:${id}`,
    title:
      structuredTitle([attributes.Brand, attributes.Model, attributes.Year]) ??
      asText(hit.title) ??
      'Listing',
    // The hit's top-level `price` is 0 on current pages; the asking price lives in extraFields.
    priceEgp: asPrice(extra.price) ?? asPrice(hit.price) ?? null,
    url: `${SITE}/ad/${id}`,
    imageUrl: cover ? `https://images.dubizzle.com.eg/thumbnails/${cover}-600x450.webp` : null,
    description: description ?? null,
    attributes,
    sellerId: asText(hit.userExternalID) ?? null,
  };
}

function parseAppState(html: string): AppState {
  const state = extractAssignedJson(html, 'window.state');
  const algolia = isObject(state) && isObject(state.algolia) ? state.algolia : undefined;
  const content = algolia && isObject(algolia.content) ? algolia.content : undefined;

  const listings = new Map<string, Listing>();
  for (const hit of asArray(content?.hits)) {
    const listing = isObject(hit) ? listingFromHit(hit) : undefined;
    if (listing && !listings.has(listing.key)) listings.set(listing.key, listing);
  }

  const totalPages = Number(content?.nbPages);
  const known = Number.isInteger(totalPages) && totalPages > 0;
  return {
    listings, totalPages: known ? totalPages : undefined,
    explicitlyEmpty: Array.isArray(content?.hits) && content.hits.length === 0 && content.nbHits === 0,
  };
}

// ── Layer 2: JSON-LD ───────────────────────────────────────────────────────────────────────────

interface StructuredAd {
  readonly title?: string;
  readonly priceEgp?: number;
  readonly imageUrl?: string;
}

interface StructuredData {
  readonly ads: Map<string, StructuredAd>;
  /** The search's total result count, for estimating pages when the app state is missing. */
  readonly numberOfItems?: number;
}

function parseStructuredData(html: string): StructuredData {
  const ads = new Map<string, StructuredAd>();
  let numberOfItems: number | undefined;

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isObject(node)) return;

    if (node['@type'] === 'ItemList' && typeof node.numberOfItems === 'number') {
      numberOfItems ??= node.numberOfItems;
    }

    // Any offered item — a Car on a car search, a Product on a phone search.
    const offer = asArray(node.offers)[0];
    if (isObject(offer)) {
      const id = (asText(offer.url) ?? asText(node.url) ?? '').match(ID_IN_URL)?.[1];
      if (id && !ads.has(id)) {
        const brand = isObject(node.brand) ? asText(node.brand.name) : undefined;
        ads.set(id, {
          title:
            structuredTitle([brand, asText(node.model), asText(node.vehicleModelDate)]) ??
            asText(node.name),
          priceEgp: asPrice(offer.price),
          imageUrl: asText(asArray(node.image)[0]),
        });
      }
    }

    Object.values(node).forEach(visit);
  };

  for (const match of html.matchAll(JSON_LD)) {
    try {
      visit(JSON.parse(match[1] ?? ''));
    } catch {
      // A single malformed block must not lose the other blocks (or the layers around it).
    }
  }

  return { ads, numberOfItems };
}

// ── Layer 3: analytics id arrays ───────────────────────────────────────────────────────────────

function parseAdIds(html: string): string[] {
  const ids: string[] = [];
  for (const arrayMatch of html.matchAll(AD_IDS_ARRAY)) {
    for (const idMatch of (arrayMatch[1] ?? '').matchAll(/"(\d+)"/g)) {
      if (idMatch[1]) ids.push(idMatch[1]);
    }
  }
  return ids;
}

/**
 * Fallback title for an ad only the id arrays know about, from the search URL we fetched
 * (".../used/seat/model-leon/" → "Seat Leon"). The page is already narrowed to that make/model.
 */
function titleFromSourceUrl(sourceUrl: string | undefined): string | undefined {
  const match = sourceUrl?.match(/\/cars-for-sale\/[a-z-]+\/([a-z0-9-]+)\/model-([a-z0-9-]+)/i);
  const make = match?.[1];
  const model = match?.[2];
  return make && model ? slugToTitle(`${make} ${model}`) : undefined;
}

/** The URL of page `page` (1-based) of a Dubizzle search. */
export function dubizzlePageUrl(url: string, page: number): string {
  const next = new URL(url);
  if (page <= 1) next.searchParams.delete('page');
  else next.searchParams.set('page', String(page));
  return next.toString();
}

/**
 * Parse one Dubizzle results page.
 *
 * `sourceUrl` is the search URL this HTML came from; it supplies the make/model for any ad the
 * richer layers missed. Optional so the parser stays usable on a bare fixture.
 */
export function parseDubizzle(html: string, sourceUrl?: string): ParsedPage {
  const app = parseAppState(html);
  const structured = parseStructuredData(html);
  const adIds = parseAdIds(html);

  const byKey = new Map(app.listings);
  const urlTitle = titleFromSourceUrl(sourceUrl);

  for (const id of [...structured.ads.keys(), ...adIds]) {
    const key = `dubizzle:${id}`;
    if (byKey.has(key)) continue;
    const ad = structured.ads.get(id);
    byKey.set(key, {
      key,
      title: ad?.title ?? urlTitle ?? 'Listing',
      priceEgp: ad?.priceEgp ?? null,
      url: `${SITE}/ad/${id}`,
      imageUrl: ad?.imageUrl ?? null,
      description: null,
      attributes: {},
      sellerId: null,
    });
  }

  if (byKey.size === 0 && !app.explicitlyEmpty && structured.numberOfItems !== 0) {
    throw new Error('Dubizzle: no listing data or explicit zero-result count — challenge or changed page');
  }

  // Page count: straight from the app state, else estimated from the JSON-LD total and how many ads
  // this page held (page 1 is always full when there's more than one page).
  const estimatedPages =
    structured.numberOfItems && byKey.size
      ? Math.ceil(structured.numberOfItems / byKey.size)
      : 1;

  return { listings: [...byKey.values()], totalPages: app.totalPages ?? estimatedPages };
}

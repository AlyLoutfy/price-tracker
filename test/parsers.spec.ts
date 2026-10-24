import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyFilters } from '../src/filters';
import { dubizzlePageUrl, parseDubizzle } from '../src/parsers/dubizzle';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string): string => readFileSync(resolve(fixtures, name), 'utf8');

const LEON_SEARCH_URL =
  'https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/seat/model-leon/?filter=year_min_2021';

describe('parseDubizzle — recovered SEAT Leon results', () => {
  it('preserves all seven live listing prices, years and mileage from the original response', () => {
    const { listings, totalPages } = parseDubizzle(read('dubizzle-leon.html'), LEON_SEARCH_URL);
    expect(totalPages).toBe(1);
    expect(listings).toHaveLength(7);
    expect(listings[0]).toMatchObject({
      key: 'dubizzle:209303617', priceEgp: 1475000,
      attributes: { Year: '2026', Kilometers: '14000' },
    });
    expect(applyFilters(listings, {
      id: 'leon', label: 'SEAT Leon', url: LEON_SEARCH_URL,
      filters: { priceMin: 900000, priceMax: 1510000 },
    })).toHaveLength(7);
  });

  it('rejects a JavaScript challenge that returns HTTP 200 and no actual result data', () => {
    const challenge = '<html><head><script src="https://www.dubizzle.com.eg/.humbucker/clients/browser.js"></script></head><body><script>challenge()</script></body></html>';
    expect(() => parseDubizzle(challenge, LEON_SEARCH_URL)).toThrow(/no listing data/);
  });

  it('accepts an explicitly empty app-state search or JSON-LD ItemList', () => {
    expect(parseDubizzle('<script>window.state = {"algolia":{"content":{"hits":[],"nbHits":0,"nbPages":0}}};</script>').listings).toEqual([]);
    expect(parseDubizzle('<script type="application/ld+json">{"@type":"ItemList","numberOfItems":0}</script>').listings).toEqual([]);
  });

  it('rejects a missing result set when the page claims there are matching ads', () => {
    expect(() => parseDubizzle('<script>window.state = {"algolia":{"content":{"hits":[],"nbHits":7,"nbPages":1}}};</script>')).toThrow(/no listing data/);
  });
});

describe('parseDubizzle — from the app state (window.state)', () => {
  const { listings, totalPages } = parseDubizzle(read('dubizzle-phones.html'));
  const byKey = (key: string) => listings.find((listing) => listing.key === key);

  it('finds every ad across the app state, JSON-LD and every ad_ids array', () => {
    // 300000004 is only in the JSON-LD; 300000005 only in "ad_ids_set_3" — a third array the
    // parser once ignored, silently dropping a page's worth of phone ads.
    expect(listings.map((listing) => listing.key).sort()).toEqual([
      'dubizzle:300000001',
      'dubizzle:300000002',
      'dubizzle:300000003',
      'dubizzle:300000004',
      'dubizzle:300000005',
    ]);
  });

  it('reads the seller description, which the tax and battery checks depend on', () => {
    expect(byKey('dubizzle:300000001')?.description).toBe('iPhone 17 256GB\nبطاريه ٩٨٪ معفي ضريبه');
  });

  it('survives braces and escaped quotes inside strings, and script after the object', () => {
    expect(byKey('dubizzle:300000002')?.description).toBe(
      'عليه ضريبه ١٨ الف "زيرو" {خدوش: لا} بطاريه 100',
    );
  });

  it('takes the asking price from extraFields, not the zeroed top-level price', () => {
    expect(byKey('dubizzle:300000001')?.priceEgp).toBe(58000);
    expect(byKey('dubizzle:300000002')?.priceEgp).toBe(44500);
  });

  it('keeps the structured fields by English label, minus the price', () => {
    expect(byKey('dubizzle:300000003')?.attributes).toEqual({
      Brand: 'Apple - iPhone',
      Model: '17',
      Storage: '512 GB',
    });
  });

  it('titles ads in Latin from brand/model, and builds the photo and a resolvable link', () => {
    const phone = byKey('dubizzle:300000002');
    expect(phone?.title).toBe('Apple - iPhone 17'); // the seller wrote it in Arabic
    expect(phone?.imageUrl).toBe('https://images.dubizzle.com.eg/thumbnails/222-600x450.webp');
    expect(phone?.url).toBe('https://www.dubizzle.com.eg/ad/300000002');
    expect(byKey('dubizzle:300000003')?.imageUrl).toBeNull(); // no cover photo
  });

  it('prices phone ads from JSON-LD "Product" entries when the app state lacks them', () => {
    const ad = byKey('dubizzle:300000004');
    expect(ad?.priceEgp).toBe(50000);
    expect(ad?.title).toBe('iPhone 17 for sale');
    expect(ad?.description).toBeNull();
  });

  it('records who posted the ad, so a repost under a new id can be recognised', () => {
    expect(byKey('dubizzle:300000001')?.sellerId).toBe('e805712c-c468-4534-8cb5-52ae7231a05f');
    expect(byKey('dubizzle:300000004')?.sellerId).toBeNull(); // JSON-LD doesn't say
  });

  it('keeps an id only the analytics arrays know about, unpriced rather than dropped', () => {
    expect(byKey('dubizzle:300000005')?.priceEgp).toBeNull();
  });

  it('reports the page count, so every page of results gets read', () => {
    expect(totalPages).toBe(3);
  });
});

describe('parseDubizzle — fallback layers only (no app state)', () => {
  const { listings, totalPages } = parseDubizzle(read('dubizzle-no-app-state.html'), LEON_SEARCH_URL);
  const byKey = (key: string) => listings.find((listing) => listing.key === key);

  it('extracts every ad, keyed by the stable numeric id, including ids only ad_ids knows', () => {
    expect(listings.map((listing) => listing.key).sort()).toEqual([
      'dubizzle:208149106',
      'dubizzle:208239498',
      'dubizzle:208274361',
      'dubizzle:208555001',
      'dubizzle:208777777',
      'dubizzle:208999999',
    ]);
  });

  it('reads prices and Latin titles out of the JSON-LD Car entries', () => {
    expect(byKey('dubizzle:208239498')?.priceEgp).toBe(1225000);
    expect(byKey('dubizzle:208274361')?.title).toBe('Seat Leon 2022'); // headline is Arabic
    expect(byKey('dubizzle:208239498')?.imageUrl).toBe(
      'https://images.dubizzle.com.eg/thumbnails/178635000-600x450.webp',
    );
  });

  it('falls back to the search URL for the make/model of an ad nothing else describes', () => {
    expect(byKey('dubizzle:208999999')?.title).toBe('Seat Leon');
    expect(byKey('dubizzle:208999999')?.priceEgp).toBeNull();
  });

  it('survives a malformed JSON-LD block without losing the valid one', () => {
    expect(byKey('dubizzle:208274361')?.priceEgp).toBe(1300000);
  });

  it('estimates a single page when every result fits on it', () => {
    expect(totalPages).toBe(1);
  });

  it('produces prices the configured band can act on', () => {
    const kept = applyFilters(listings, {
      id: 't',
      label: 't',
      url: LEON_SEARCH_URL,
      filters: { priceMin: 900000, priceMax: 1510000 },
    }).map((match) => match.listing.key);
    expect(kept).not.toContain('dubizzle:208555001'); // 2,400,000 — over band
    expect(kept).toContain('dubizzle:208239498'); // 1,225,000 — in band
    expect(kept).toContain('dubizzle:208999999'); // unpriced — surfaced, not lost
  });
});

describe('dubizzlePageUrl', () => {
  it('adds the page number alongside the filters already in the link', () => {
    expect(dubizzlePageUrl(LEON_SEARCH_URL, 2)).toBe(
      'https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/seat/model-leon/?filter=year_min_2021&page=2',
    );
  });

  it('leaves page 1 as the link itself', () => {
    expect(dubizzlePageUrl(`${LEON_SEARCH_URL}&page=4`, 1)).toBe(LEON_SEARCH_URL);
  });
});

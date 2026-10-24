import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getOffers,
  getSeen,
  loadState,
  mergeSeen,
  pruneState,
  saveState,
  setSeen,
  type SeenState,
} from '../src/state';

const URL_A = 'https://www.dubizzle.com.eg/en/a/';
const URL_B = 'https://www.dubizzle.com.eg/en/b/';

describe('getSeen / setSeen', () => {
  it('returns undefined for a tracker never recorded (first-run signal)', () => {
    expect(getSeen({}, 'seat-leon', URL_A)).toBeUndefined();
  });

  it('round-trips recorded keys; an empty array means "seen, nothing there"', () => {
    const state: SeenState = {};
    setSeen(state, 'seat-leon', URL_A, ['a', 'b']);
    expect(getSeen(state, 'seat-leon', URL_A)).toEqual(['a', 'b']);
    setSeen(state, 'iphone', URL_B, []);
    expect(getSeen(state, 'iphone', URL_B)).toEqual([]);
  });

  it('treats an edited link as a new search, so it is re-seeded rather than diffed', () => {
    const state: SeenState = {};
    setSeen(state, 'seat-leon', URL_A, ['a']);
    expect(getSeen(state, 'seat-leon', URL_B)).toBeUndefined();
  });
});

describe('getOffers / setSeen offers', () => {
  it('keeps only the offers of keys still recorded', () => {
    const state: SeenState = {};
    setSeen(state, 'iphone', URL_A, ['a'], { a: 'x|256 GB|1', evicted: 'y|256 GB|2' });
    expect(getOffers(state, 'iphone', URL_A)).toEqual({ a: 'x|256 GB|1' });
  });

  it('has none for a tracker never seen, recorded before offers existed, or whose link changed', () => {
    const state: SeenState = { old: { url: URL_A, keys: ['a'] } };
    setSeen(state, 'iphone', URL_A, ['a'], { a: 'x|256 GB|1' });
    expect(getOffers(state, 'nope', URL_A)).toEqual({});
    expect(getOffers(state, 'old', URL_A)).toEqual({});
    expect(getOffers(state, 'iphone', URL_B)).toEqual({});
  });
});

describe('loadState', () => {
  it('round-trips product prices and delivery state alongside existing listing history', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'seen-')), 'seen.json');
    const state: SeenState = {
      iphone: { url: URL_B, keys: ['dubizzle:2'] },
      shoe: { url: 'https://www.asics.com/', keys: ['asics:1'], product: {
        price: 80, referencePrice: 100, currency: 'EUR', inStock: true,
        checkedAt: '2026-10-24T12:00:00Z', alertedPrice: 80,
      } },
    };
    saveState(path, state);
    expect(loadState(path)).toEqual(state);
  });

  it('drops entries in the old per-site shape instead of mis-reading them', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'seen-')), 'seen.json');
    writeFileSync(
      path,
      JSON.stringify({
        'seat-leon': { dubizzle: ['dubizzle:1'], sylndr: ['sylndr:x'] },
        iphone: { url: URL_B, keys: ['dubizzle:2'], offers: { 'dubizzle:2': 'x|256 GB|1' } },
      }),
    );
    expect(loadState(path)).toEqual({
      iphone: { url: URL_B, keys: ['dubizzle:2'], offers: { 'dubizzle:2': 'x|256 GB|1' } },
    });
  });

  it('starts empty when the file is missing or corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seen-'));
    expect(loadState(join(dir, 'missing.json'))).toEqual({});
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(loadState(join(dir, 'bad.json'))).toEqual({});
  });
});

describe('pruneState', () => {
  it('forgets trackers that are no longer configured', () => {
    const state: SeenState = { keep: { url: URL_A, keys: [] }, gone: { url: URL_B, keys: [] } };
    pruneState(state, new Set(['keep']));
    expect(Object.keys(state)).toEqual(['keep']);
  });
});

describe('mergeSeen', () => {
  it('appends only genuinely-new keys', () => {
    expect(mergeSeen(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('does not re-add keys that are still present', () => {
    expect(mergeSeen(['a'], ['a'])).toEqual(['a']);
  });

  it('never evicts a still-present key, even past the cap', () => {
    const present = Array.from({ length: 1600 }, (_, index) => `p-${index}`);
    const merged = mergeSeen(present, present, 1500);
    // Cap is exceeded rather than dropping a live key (which would re-alert it).
    expect(merged).toHaveLength(1600);
    expect(merged.includes('p-0')).toBe(true);
  });

  it('evicts only departed keys, oldest-first, when over the cap', () => {
    const previous = [...Array.from({ length: 1500 }, (_, index) => `gone-${index}`), 'live'];
    const merged = mergeSeen(previous, ['live'], 10);
    expect(merged.includes('live')).toBe(true); // still present → always kept
    expect(merged).toHaveLength(10); // 9 most-recent departed + the live key
    expect(merged.includes('gone-1499')).toBe(true); // most recent departed kept
    expect(merged.includes('gone-0')).toBe(false); // oldest departed dropped
  });
});

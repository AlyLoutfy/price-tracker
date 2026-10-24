import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTrackers } from '../src/config';

function configFile(trackers: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'trackers-')), 'trackers.json');
  writeFileSync(path, JSON.stringify(trackers));
  return path;
}

const tracker = {
  id: 'iphone-17',
  label: 'iPhone 17',
  url: 'https://www.dubizzle.com.eg/en/mobile-phones-tablets-accessories-numbers/mobile-phones/q-used-iphone-17/',
};

describe('loadTrackers', () => {
  it('accepts the committed config', () => {
    expect(loadTrackers().length).toBeGreaterThan(0);
  });

  it('rejects a misspelt option instead of silently not filtering', () => {
    const path = configFile([{ ...tracker, filters: { minBateryHealth: 96 } }]);
    expect(() => loadTrackers(path)).toThrow(/minBateryHealth/);
  });

  it('rejects a link to a site there is no parser for', () => {
    const path = configFile([{ ...tracker, url: 'https://sylndr.com/en/buy-used-cars' }]);
    expect(() => loadTrackers(path)).toThrow(/unsupported site/);
  });

  it('rejects duplicate ids, which would share one seen-state entry', () => {
    expect(() => loadTrackers(configFile([tracker, tracker]))).toThrow(/unique/);
  });

  it('requires discount mode, an exact ASICS variant and a reference price', () => {
    const shoe = { id: 'shoe', label: 'Shoe', mode: 'discount', referencePrice: 100,
      url: 'https://www.asics.com/fr/fr-fr/gel-venture-6/p/1203A297-002.html?size=9&width=Standard' };
    expect(loadTrackers(configFile([shoe]))).toHaveLength(1);
    expect(() => loadTrackers(configFile([{ ...shoe, referencePrice: undefined }]))).toThrow(/referencePrice/);
    expect(() => loadTrackers(configFile([{ ...shoe, url: tracker.url }]))).toThrow(/ASICS/);
    expect(() => loadTrackers(configFile([{ ...shoe, filters: { priceMin: 10 } }]))).toThrow(/listing filters/);
  });
});

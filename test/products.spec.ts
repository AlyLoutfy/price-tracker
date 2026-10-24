import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trackProduct } from '../src/products';
import type { SeenState } from '../src/state';
import type { TrackerConfig } from '../src/types';
import type { ProductSnapshot } from '../src/parsers/asics';

const url = 'https://www.asics.com/fr/fr-fr/gel-venture-6/p/1203A297-002.html?size=9&width=Standard';
const tracker: TrackerConfig = { id: 'shoe', label: 'GEL-VENTURE 6', url, mode: 'discount', referencePrice: 100 };
const snapshot = (price: number, inStock = true): ProductSnapshot => ({
  key: 'asics:1203A297-002:4550457173490', title: 'GEL-VENTURE 6',
  price, inStock, currency: 'EUR', size: '9', sizeLabel: '42.5', width: 'Standard', color: 'Black/Black',
});
const send = vi.fn<(html: string) => Promise<void>>();
const check = (state: SeenState, price: number, inStock = true) =>
  trackProduct(tracker, state, { collect: async () => snapshot(price, inStock), send });

beforeEach(() => {
  send.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('discount tracking', () => {
  it('seeds quietly and sends nothing for unchanged prices or increases', async () => {
    const state: SeenState = {};
    expect(await check(state, 100)).toMatchObject({ kind: 'seed', sent: 0 });
    await check(state, 100);
    await check(state, 110);
    expect(send).not.toHaveBeenCalled();
  });

  it('alerts an existing discount on its first fetch, in EUR, with the exact link', async () => {
    const state: SeenState = {};
    expect(await check(state, 80)).toMatchObject({ sent: 1 });
    const message = send.mock.calls[0]![0];
    expect(message).toContain('80.00 EUR');
    expect(message).toContain('20% off');
    expect(message).toContain('size=9&amp;width=Standard');
    expect(message).not.toContain('EGP');
    expect(state.shoe?.product?.alertedPrice).toBe(80);
  });

  it('alerts once per sale and further reduction, suppressing repeats and price rises', async () => {
    const state: SeenState = {};
    for (const price of [100, 80, 80, 90, 80, 70, 70]) await check(state, price);
    expect(send).toHaveBeenCalledTimes(2);
    expect(state.shoe?.product?.alertedPrice).toBe(70);
  });

  it('alerts a new sale after the product returns to full price', async () => {
    const state: SeenState = {};
    for (const price of [80, 100, 80]) await check(state, price);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retries a failed delivery even when the discounted price stays the same', async () => {
    const state: SeenState = {};
    send.mockRejectedValueOnce(new Error('Telegram unavailable'));
    expect(await check(state, 80)).toMatchObject({ sent: 0, sendFailures: 1 });
    expect(state.shoe?.product?.alertedPrice).toBeUndefined();
    expect(await check(state, 80)).toMatchObject({ sent: 1, sendFailures: 0 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('waits for the requested size to be in stock before alerting', async () => {
    const state: SeenState = {};
    await check(state, 80, false);
    expect(send).not.toHaveBeenCalled();
    await check(state, 80, true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('preserves the last quote on fetch or parse failure', async () => {
    const state: SeenState = {};
    await check(state, 100);
    const previous = structuredClone(state);
    const result = await trackProduct(tracker, state, {
      collect: async () => { throw new Error('blocked'); }, send,
    });
    expect(result.kind).toBe('failed');
    expect(state).toEqual(previous);
    expect(send).not.toHaveBeenCalled();
  });

  it('resets discount state if the tracked URL changes', async () => {
    const state: SeenState = {};
    await check(state, 80);
    await trackProduct({ ...tracker, url: `${url}&changed=1` }, state, {
      collect: async () => snapshot(80), send,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

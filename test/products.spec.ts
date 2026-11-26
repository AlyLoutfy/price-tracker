import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trackProduct, trackStock } from '../src/products';
import type { SeenState } from '../src/state';
import type { ProductSnapshot, TrackerConfig } from '../src/types';

const url = 'https://www.asics.com/fr/fr-fr/gel-venture-6/p/1203A297-002.html?size=9&width=Standard';
const tracker: TrackerConfig = { id: 'shoe', label: 'GEL-VENTURE 6', url, mode: 'discount', referencePrice: 100 };
const snapshot = (price: number, inStock = true): ProductSnapshot => ({
  key: 'asics:1203A297-002:4550457173490', title: 'GEL-VENTURE 6', price, inStock, currency: 'EUR',
  size: '9', sizeLabel: '42.5', width: 'Standard', color: 'Black/Black', store: 'ASICS France',
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
    expect(message).toContain('Size EU 42.5 · Standard · In stock');
    expect(message).toContain('size=9&amp;width=Standard">Open on ASICS France</a>');
    expect(message).not.toContain('EGP');
    expect(state.shoe?.product?.alertedPrice).toBe(80);
  });

  it('names the store and leaves out the width when the store has none', async () => {
    const dunk: TrackerConfig = {
      id: 'dunk', label: 'Dunk Low', mode: 'discount', referencePrice: 119.99,
      url: 'https://www.nike.com/fr/t/chaussures-nike-dunk-low-retro-pour-homme-GeHBr62V/HF5441-105?size=43',
    };
    await trackProduct(dunk, {}, { send, collect: async () => ({
      key: 'nike:HF5441-105:22e958a0', title: 'Nike Dunk Low Retro', price: 71.99, inStock: true,
      currency: 'EUR', size: '43', sizeLabel: '43', color: 'Blanc/Blanc/Light Smoke Grey', store: 'Nike France',
    }) });
    const message = send.mock.calls[0]![0];
    expect(message).toContain('Size EU 43 · In stock');
    expect(message).toContain('<s>119.99 EUR</s> → <b>71.99 EUR</b> (40% off)');
    expect(message).toContain('HF5441-105?size=43">Open on Nike France</a>');
  });

  it('shows EGP as Zara Egypt does and lists the sizes in stock for a whole-colour watch', async () => {
    const jumper: TrackerConfig = {
      id: 'jumper', label: 'Argyle jumper', mode: 'discount', referencePrice: 2590,
      url: 'https://www.zara.com/eg/en/brushed-effect-argyle-jumper-p05755112.html?v1=554794390',
    };
    await trackProduct(jumper, {}, { send, collect: async () => ({
      key: 'zara:554794390', title: 'BRUSHED-EFFECT ARGYLE JUMPER', price: 1813, inStock: true,
      currency: 'EGP', color: 'Grey / Blue', sizesInStock: ['L', 'XL'], store: 'Zara Egypt',
    }) });
    const message = send.mock.calls[0]![0];
    expect(message).toContain('In stock: L · XL');
    expect(message).toContain('<s>2,590 EGP</s> → <b>1,813 EGP</b> (30% off)');
    expect(message).toContain('Save 777 EGP');
    expect(message).toContain('?v1=554794390">Open on Zara Egypt</a>');
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

  it('reports why the product could not be read', async () => {
    expect(await trackProduct(tracker, {}, { collect: async () => { throw new Error('ASICS: blocked'); }, send }))
      .toMatchObject({ kind: 'failed', error: 'ASICS: blocked' });
  });
});

describe('stock tracking', () => {
  const page = 'https://www.zara.com/eg/en/comfort-textured-chino-trousers-p00706650.html?v1=551275789';
  const chinos: TrackerConfig = { id: 'chinos', label: 'Chinos · Light beige · 38', mode: 'stock', url: `${page}&size=38` };
  // Size 38 of the Light beige chinos as Zara Egypt listed it on 26 November 2026: reduced, sold out.
  const size38 = (inStock: boolean, extra: Partial<ProductSnapshot> = {}): ProductSnapshot => ({
    key: 'zara:551275789:551253801', title: 'COMFORT TEXTURED CHINO TROUSERS', price: 1550, oldPrice: 2590,
    currency: 'EGP', inStock, color: 'Light beige', size: '38', sizesInStock: inStock ? ['38'] : [],
    pageUrl: page, store: 'Zara Egypt', ...extra,
  });
  const watch = (state: SeenState, inStock: boolean, extra?: Partial<ProductSnapshot>) =>
    trackStock(chinos, state, { collect: async () => size38(inStock, extra), send });

  it('says once that a new watch is running while its size is sold out, then stays quiet', async () => {
    const state: SeenState = {};
    expect(await watch(state, false)).toMatchObject({ kind: 'seed', sent: 1 });
    const message = send.mock.calls[0]![0];
    expect(message).toContain('👀 <b>Price Tracker — Now watching</b>');
    expect(message).toContain('Size 38 · Sold out');
    expect(message).toContain('<s>2,590 EGP</s> → <b>1,550 EGP</b> (40.2% off)');
    expect(message).toContain('Every size is sold out right now.');
    expect(message).toContain('when size 38 is back in stock');
    expect(message).toContain(`<a href="${page}">Open on Zara Egypt</a>`);
    expect(await watch(state, false)).toMatchObject({ kind: 'diff', sent: 0 });
    await watch(state, false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.chinos?.stock).toMatchObject({ inStock: false, alerted: false, price: 1550, currency: 'EGP' });
  });

  it('alerts once when the size comes back, and again after it sells out and returns', async () => {
    const state: SeenState = {};
    for (const inStock of [false, true, true, false, false, true, true]) await watch(state, inStock);
    expect(send).toHaveBeenCalledTimes(3);
    const alert = send.mock.calls[1]![0];
    expect(alert).toContain('✅ <b>Price Tracker — In stock</b>');
    expect(alert).toContain('Size 38 · In stock');
    expect(alert).toContain('<b>1,550 EGP</b>');
    expect(send.mock.calls[2]![0]).toBe(alert);
    expect(state.chinos?.stock?.alerted).toBe(true);
  });

  it('alerts straight away when a new watch finds its size in stock, flagging a nearly-gone size', async () => {
    const state: SeenState = {};
    expect(await watch(state, true, { lowStock: true, oldPrice: undefined, price: 2590 })).toMatchObject({ kind: 'seed', sent: 1 });
    expect(send.mock.calls[0]![0]).toContain('Size 38 · Only a few left');
    expect(send.mock.calls[0]![0]).toContain('<b>2,590 EGP</b>');
    expect(send.mock.calls[0]![0]).not.toContain('<s>');
    await watch(state, true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries an undelivered alert, or an undelivered "now watching" note, on the next run', async () => {
    const state: SeenState = {};
    send.mockRejectedValueOnce(new Error('Telegram unavailable'));
    expect(await watch(state, false)).toMatchObject({ kind: 'seed', sent: 0, sendFailures: 1 });
    expect(state.chinos).toBeUndefined();
    expect(await watch(state, false)).toMatchObject({ kind: 'seed', sent: 1 });
    send.mockRejectedValueOnce(new Error('Telegram unavailable'));
    expect(await watch(state, true)).toMatchObject({ sent: 0, sendFailures: 1 });
    expect(state.chinos?.stock?.alerted).toBe(false);
    expect(await watch(state, true)).toMatchObject({ sent: 1 });
    expect(state.chinos?.stock?.alerted).toBe(true);
  });

  it('lists the other sizes in stock, and names an ASICS size the way ASICS does', async () => {
    await trackStock({ ...chinos, id: 'jumper' }, {}, { send, collect: async () => ({
      ...size38(false), title: 'BRUSHED-EFFECT ARGYLE JUMPER', size: 'M', sizesInStock: ['L', 'XL'],
    }) });
    expect(send.mock.calls[0]![0]).toContain('Other sizes in stock: L · XL');
    await trackStock({ ...tracker, mode: 'stock', referencePrice: undefined }, {}, {
      send, collect: async () => snapshot(100, false),
    });
    const asics = send.mock.calls[1]![0];
    expect(asics).toContain('Size EU 42.5 · Standard · Sold out');
    expect(asics).toContain('when size EU 42.5 · Standard is back in stock');
    expect(asics).toContain('<b>100.00 EUR</b>');
    expect(asics).not.toContain('sold out right now');
    expect(asics).toContain('size=9&amp;width=Standard">Open on ASICS France</a>');
  });

  it('keeps its state and reports the error when the product cannot be read', async () => {
    const state: SeenState = {};
    await watch(state, false);
    const previous = structuredClone(state);
    const failure = new Error('Zara: no size 38 in Light beige; it comes in 36, 40');
    const result = await trackStock(chinos, state, { collect: async () => { throw failure; }, send });
    expect(result).toMatchObject({ kind: 'failed', error: failure.message });
    expect(state).toEqual(previous);
  });

  it('starts afresh when the watched link changes, e.g. to another size', async () => {
    const state: SeenState = {};
    await watch(state, true);
    await trackStock({ ...chinos, url: `${page}&size=40` }, state, { collect: async () => size38(true), send });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

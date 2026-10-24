import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSeen, type SeenState } from '../src/state';
import { failureReason, trackLink, type TrackDeps, type TrackOutcome } from '../src/track';
import type { Listing, TrackerConfig } from '../src/types';

const URL_A = 'https://www.dubizzle.com.eg/en/a/';

const tracker: TrackerConfig = { id: 'leon', label: 'Leon', url: URL_A };

/** An ad by its own seller (so never a repost) unless `seller` says otherwise. */
const listing = (id: string, seller = `seller-${id}`, priceEgp = 1_000_000): Listing => ({
  key: `dubizzle:${id}`,
  title: `Seat Leon ${id}`,
  priceEgp,
  url: `https://www.dubizzle.com.eg/ad/${id}`,
  imageUrl: null,
  description: null,
  attributes: {},
  sellerId: seller,
});

/** Deps that serve `listings` and record every message sent, failing the ones `fails` picks. */
function fakeDeps(listings: Listing[], fails: (html: string) => boolean = () => false) {
  const sent: string[] = [];
  const deps: TrackDeps = {
    collect: async () => listings,
    send: async (html) => {
      if (fails(html)) throw new Error('Telegram said no');
      sent.push(html);
    },
  };
  return { deps, sent };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('trackLink', () => {
  it('seeds a new link with one digest and records every match', async () => {
    const state: SeenState = {};
    const { deps, sent } = fakeDeps([listing('1'), listing('2')]);
    const outcome = await trackLink(tracker, state, deps);

    expect(outcome).toMatchObject({ kind: 'seed', sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Now tracking');
    expect(getSeen(state, 'leon', URL_A)).toEqual(['dubizzle:1', 'dubizzle:2']);
  });

  it('alerts only the new ad on the next run, then nothing on the one after', async () => {
    const state: SeenState = { leon: { url: URL_A, keys: ['dubizzle:1'] } };
    const first = fakeDeps([listing('1'), listing('2')]);
    await trackLink(tracker, state, first.deps);
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]).toContain('Seat Leon 2');

    const second = fakeDeps([listing('1'), listing('2')]);
    await trackLink(tracker, state, second.deps);
    expect(second.sent).toHaveLength(0);
  });

  it('retries an alert whose send failed, instead of marking it seen', async () => {
    const state: SeenState = { leon: { url: URL_A, keys: ['dubizzle:1'] } };
    const failing = fakeDeps([listing('1'), listing('2'), listing('3')], (html) =>
      html.includes('Seat Leon 3'),
    );
    const outcome = await trackLink(tracker, state, failing.deps);
    expect(outcome).toMatchObject({ kind: 'diff', sent: 1, sendFailures: 1 });
    expect(getSeen(state, 'leon', URL_A)).not.toContain('dubizzle:3');

    const retry = fakeDeps([listing('1'), listing('2'), listing('3')]);
    await trackLink(tracker, state, retry.deps);
    expect(retry.sent).toHaveLength(1);
    expect(retry.sent[0]).toContain('Seat Leon 3');
  });

  it('re-seeds, rather than alerting every ad, when the link was edited', async () => {
    const state: SeenState = { leon: { url: 'https://www.dubizzle.com.eg/en/old/', keys: [] } };
    const { deps, sent } = fakeDeps([listing('1'), listing('2')]);
    expect((await trackLink(tracker, state, deps)).kind).toBe('seed');
    expect(sent).toHaveLength(1);
    expect(state.leon?.url).toBe(URL_A);
  });

  it('leaves state untouched when the link cannot be read', async () => {
    const state: SeenState = { leon: { url: URL_A, keys: ['dubizzle:1'] } };
    const deps: TrackDeps = {
      collect: async () => {
        throw new Error('HTTP 503');
      },
      send: async () => {},
    };
    expect((await trackLink(tracker, state, deps)).kind).toBe('failed');
    expect(state.leon).toEqual({ url: URL_A, keys: ['dubizzle:1'] });
  });

  it('skips a repost of an ad that is still listed, and never alerts it later either', async () => {
    const state: SeenState = {};
    await trackLink(tracker, state, fakeDeps([listing('1', 'ahmed', 43000)]).deps); // seed

    const repost = fakeDeps([listing('1', 'ahmed', 43000), listing('2', 'ahmed', 43000)]);
    const outcome = await trackLink(tracker, state, repost.deps);
    expect(outcome).toMatchObject({ sent: 0, reposts: 1 });
    expect(repost.sent).toHaveLength(0);
    expect(getSeen(state, 'leon', URL_A)).toContain('dubizzle:2');
  });

  it('skips a repost of an ad that was taken down before being posted again', async () => {
    const state: SeenState = {};
    await trackLink(tracker, state, fakeDeps([listing('1', 'ahmed', 43000)]).deps); // seed
    await trackLink(tracker, state, fakeDeps([listing('9', 'mona')]).deps); // ad 1 deleted

    const bumped = fakeDeps([listing('9', 'mona'), listing('2', 'ahmed', 42500)]);
    await trackLink(tracker, state, bumped.deps);
    expect(bumped.sent).toHaveLength(0);
  });

  it('alerts once when a seller posts the same offer twice in one hour', async () => {
    const state: SeenState = { leon: { url: URL_A, keys: ['dubizzle:1'] } };
    const twins = fakeDeps([listing('1'), listing('2', 'ahmed', 43000), listing('3', 'ahmed', 43000)]);
    await trackLink(tracker, state, twins.deps);
    expect(twins.sent).toHaveLength(1);
    expect(getSeen(state, 'leon', URL_A)).toEqual(['dubizzle:1', 'dubizzle:2', 'dubizzle:3']);
  });

  it('still alerts a different offer from the same seller, e.g. a real price drop', async () => {
    const state: SeenState = {};
    await trackLink(tracker, state, fakeDeps([listing('1', 'ahmed', 43000)]).deps); // seed
    const cheaper = fakeDeps([listing('1', 'ahmed', 43000), listing('2', 'ahmed', 38000)]);
    await trackLink(tracker, state, cheaper.deps);
    expect(cheaper.sent).toHaveLength(1);
  });

  it('lists one ad per offer in the first-run digest', async () => {
    const { deps, sent } = fakeDeps([listing('1', 'ahmed', 43000), listing('2', 'ahmed', 43000)]);
    await trackLink(tracker, {}, deps);
    expect(sent[0]).toContain('1 ad match right now');
  });

  it('records a new link even if its digest fails, so it never floods you with alerts later', async () => {
    const state: SeenState = {};
    const { deps } = fakeDeps([listing('1')], () => true);
    expect(await trackLink(tracker, state, deps)).toMatchObject({ kind: 'seed', sendFailures: 1 });
    expect(getSeen(state, 'leon', URL_A)).toEqual(['dubizzle:1']);
  });
});

describe('failureReason', () => {
  const outcome = (overrides: Partial<TrackOutcome>): TrackOutcome => ({
    kind: 'diff',
    matches: 1,
    sent: 0,
    sendFailures: 0,
    ...overrides,
  });

  it('passes a normal run, including a quiet one with nothing new', () => {
    expect(failureReason([outcome({ sent: 2 }), outcome({})])).toBeUndefined();
  });

  it('passes when only some messages failed — those are retried next run', () => {
    expect(failureReason([outcome({ sent: 1, sendFailures: 1 })])).toBeUndefined();
  });

  it('reports an unreadable search even when another site succeeded', () => {
    expect(failureReason([outcome({ kind: 'failed' }), outcome({})])).toMatch(/tracked links could not be read/);
  });

  it('fails when no link could be read', () => {
    expect(failureReason([outcome({ kind: 'failed' }), outcome({ kind: 'failed' })])).toMatch(
      /no tracked link/,
    );
  });

  it('fails when every message failed to send', () => {
    expect(failureReason([outcome({ sendFailures: 2 }), outcome({})])).toMatch(/Telegram/);
  });
});

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVERY_WATCH,
  formatDuration,
  loadHealth,
  planHealthReport,
  reportHealth,
  RUN,
  runLogUrl,
  saveHealth,
  WORKFLOW,
  type HealthInput,
  type HealthState,
  type Problem,
} from '../src/health';

const T0 = Date.parse('2026-11-26T12:00:00Z');
const minutes = (n: number) => new Date(T0 + n * 60_000);
const chinos: Problem = { key: 'chinos', label: 'Chinos · 38', detail: 'Zara product request failed: HTTP 403' };
const jumper: Problem = { key: 'jumper', label: 'Jumper · M', detail: 'Zara: no colour 554794390 on Zara Egypt' };
const checked = new Set([RUN, WORKFLOW, 'chinos', 'jumper']);
const fresh: HealthState = { problems: {} };
const run = (previous: HealthState, at: number, problems: Problem[], extra: Partial<HealthInput> = {}) =>
  planHealthReport(previous, { problems, checked, now: minutes(at), ...extra });

describe('planHealthReport', () => {
  it('stays quiet while everything works', () => {
    const report = run(fresh, 0, []);
    expect(report.message).toBeUndefined();
    expect(report.delivered).toEqual({ problems: {} });
  });

  it('reports a new problem once with the run log, then again only when a reminder is due', () => {
    const first = run(fresh, 0, [chinos], { runUrl: 'https://github.com/o/r/actions/runs/1' });
    expect(first.message).toBe([
      '⚠️ <b>Price Tracker — something is wrong</b>',
      '❌ <b>Chinos · 38</b>: Zara product request failed: HTTP 403',
      '<a href="https://github.com/o/r/actions/runs/1">Run log</a>',
    ].join('\n'));
    const quiet = run(first.delivered, 12 * 60 - 1, [chinos]);
    expect(quiet.message).toBeUndefined();
    const reminder = run(quiet.delivered, 12 * 60, [chinos]);
    expect(reminder.message).toContain('❌ <b>Chinos · 38</b>, still failing after 12 h: Zara product request failed');
    expect(run(reminder.delivered, 12 * 60 + 30, [chinos]).message).toBeUndefined();
  });

  it('says once that a reported problem is fixed, then forgets it', () => {
    const broken = run(fresh, 0, [chinos]).delivered;
    const fixed = run(broken, 30, []);
    expect(fixed.message).toBe('✅ <b>Price Tracker — fixed</b>\n✅ <b>Chinos · 38</b>: working again');
    expect(fixed.delivered.problems).toEqual({});
    expect(run(fixed.delivered, 60, []).message).toBeUndefined();
  });

  it('retries an undelivered report next run, keeping when the problem started', () => {
    const lost = run(fresh, 0, [chinos]);
    const retry = run(lost.undelivered, 30, [chinos]);
    expect(retry.message).toContain('❌ <b>Chinos · 38</b>: Zara');
    expect(retry.delivered.problems.chinos).toMatchObject({ since: minutes(0).toISOString(), reportedAt: minutes(30).toISOString() });
    const fixedLost = run(retry.delivered, 60, []);
    expect(run(fixedLost.undelivered, 90, []).message).toContain('working again');
  });

  it('retries an undelivered reminder next run', () => {
    const broken = run(fresh, 0, [chinos]).delivered;
    const lost = run(broken, 12 * 60, [chinos]);
    expect(run(lost.undelivered, 12 * 60 + 30, [chinos]).message).toContain('still failing after 12 h 30 min');
  });

  it('forgets without a word a problem that cleared before you heard of it, or whose watch is gone', () => {
    const unheard = run(fresh, 0, [chinos]).undelivered;
    const cleared = run(unheard, 30, []);
    expect(cleared.message).toBeUndefined();
    expect(cleared.delivered.problems).toEqual({});
    const broken = run(fresh, 0, [chinos]).delivered;
    const removed = planHealthReport(broken, { problems: [], checked: new Set([RUN, WORKFLOW]), known: new Set([RUN, WORKFLOW]), now: minutes(30) });
    expect(removed.message).toBeUndefined();
    expect(removed.delivered.problems).toEqual({});
  });

  it('leaves alone the problems of watches a run did not look at', () => {
    const broken = run(fresh, 0, [chinos]).delivered;
    const step: Problem = { key: WORKFLOW, label: EVERY_WATCH, detail: '“Typecheck and tests” failed, so nothing was checked' };
    const report = planHealthReport(broken, { problems: [step], checked: new Set([WORKFLOW]), now: minutes(30) });
    expect(report.message).toContain('❌ <b>Every watch</b>: “Typecheck and tests” failed');
    expect(report.message).not.toContain('Chinos');
    expect(report.delivered.problems.chinos).toEqual(broken.problems.chinos);
    // The next full run clears the failed step, and the watch it could read again.
    const recovered = run(report.delivered, 60, []);
    expect(recovered.message).toContain('✅ <b>Every watch</b>: working again');
    expect(recovered.message).toContain('✅ <b>Chinos · 38</b>: working again');
  });

  it('puts every change of a run in one message, failures first', () => {
    const broken = run(fresh, 0, [chinos]).delivered;
    const report = run(broken, 30, [jumper]);
    expect(report.message!.split('\n')).toEqual([
      '⚠️ <b>Price Tracker — something is wrong</b>',
      '❌ <b>Jumper · M</b>: Zara: no colour 554794390 on Zara Egypt',
      '✅ <b>Chinos · 38</b>: working again',
    ]);
  });

  it('clips a long error and escapes its HTML', () => {
    const report = run(fresh, 0, [{ ...chinos, label: '<Chinos>', detail: `<html>${'x'.repeat(400)}` }]);
    expect(report.message).toContain('❌ <b>&lt;Chinos&gt;</b>: &lt;html&gt;xxx');
    expect(report.message).toMatch(/x…$/);
    expect(report.message!.length).toBeLessThan(400);
  });

  describe('late checks', () => {
    const checks = { checks: true } as const;

    it('records when the watches were checked, and stays quiet on schedule', () => {
      const first = run(fresh, 0, [], checks);
      expect(first.message).toBeUndefined();
      expect(first.delivered.checkedAt).toBe(minutes(0).toISOString());
      expect(run(first.delivered, 35, [], checks).message).toBeUndefined();
    });

    it('notes a check that came long after the previous one, at most once a day', () => {
      const before = run(fresh, 0, [], checks).delivered;
      const late = run(before, 6 * 60 + 12, [], checks);
      expect(late.message).toMatch(/^⏰ <b>Price Tracker — checks were late<\/b>\n⏰ This check ran 6 h 12 min after the previous one/);
      expect(late.message).toContain('<code>check-interval</code>');
      const again = run(late.delivered, 12 * 60 + 12, [], checks);
      expect(again.message).toBeUndefined();
      expect(run(again.delivered, 30 * 60 + 12, [], checks).message).toContain('checks were late');
    });

    it('says nothing about a gap a reported failure already explains, or on the first check', () => {
      const stepFailed = run(fresh, 0, [{ key: WORKFLOW, label: EVERY_WATCH, detail: 'failed' }], checks).delivered;
      const recovered = run(stepFailed, 6 * 60, [], checks);
      expect(recovered.message).toBe('✅ <b>Price Tracker — fixed</b>\n✅ <b>Every watch</b>: working again');
      expect(run(fresh, 0, [], checks).message).toBeUndefined();
    });

    it('only counts runs that checked the watches', () => {
      const before = run(fresh, 0, [], checks).delivered;
      const step = planHealthReport(before, { problems: [], checked: new Set([WORKFLOW]), now: minutes(240) });
      expect(step.delivered.checkedAt).toBe(minutes(0).toISOString());
    });

    it('tries a late notice again later when it could not be delivered', () => {
      const before = run(fresh, 0, [], checks).delivered;
      const lost = run(before, 6 * 60, [], checks);
      expect(lost.undelivered.lateNoticeAt).toBeUndefined();
      expect(lost.delivered.lateNoticeAt).toBe(minutes(6 * 60).toISOString());
    });
  });
});

describe('formatDuration', () => {
  it.each([
    [30_000, '1 min'], [45 * 60_000, '45 min'], [60 * 60_000, '1 h'], [372 * 60_000, '6 h 12 min'],
    [47 * 3_600_000, '47 h'], [76 * 3_600_000, '3 days 4 h'], [72 * 3_600_000, '3 days'],
  ])('%i ms → %s', (ms, text) => expect(formatDuration(ms)).toBe(text));
});

describe('saved health', () => {
  const path = () => join(mkdtempSync(join(tmpdir(), 'health-')), 'health.json');
  const send = vi.fn<(html: string) => Promise<void>>();
  beforeEach(() => {
    send.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('round-trips, and starts clean when missing, corrupt or malformed', () => {
    const file = path();
    expect(loadHealth(file)).toEqual({ problems: {} });
    const health: HealthState = {
      problems: { chinos: { label: 'Chinos', detail: 'HTTP 403', since: '2026-11-26T12:00:00.000Z', reportedAt: '2026-11-26T12:00:00.000Z' } },
      checkedAt: '2026-11-26T12:00:00.000Z', lateNoticeAt: '2026-11-25T12:00:00.000Z',
    };
    saveHealth(file, health);
    expect(loadHealth(file)).toEqual(health);
    writeFileSync(file, '{oops');
    expect(loadHealth(file)).toEqual({ problems: {} });
    writeFileSync(file, JSON.stringify({ problems: { bad: { label: 1 } }, checkedAt: 'yesterday' }));
    expect(loadHealth(file)).toEqual({ problems: {} });
  });

  it('records a delivered report, and keeps an undelivered one to retry', async () => {
    const file = path();
    const input = { problems: [chinos], checked, now: minutes(0) };
    send.mockRejectedValueOnce(new Error('Telegram unavailable'));
    expect(await reportHealth(file, input, send, { save: true })).toBe('failed');
    expect(loadHealth(file).problems.chinos?.reportedAt).toBeUndefined();
    expect(await reportHealth(file, { ...input, now: minutes(30) }, send, { save: true })).toBe('sent');
    expect(loadHealth(file).problems.chinos?.reportedAt).toBe(minutes(30).toISOString());
    expect(await reportHealth(file, { ...input, now: minutes(60) }, send, { save: true })).toBe('quiet');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('writes nothing on a dry run', async () => {
    const file = path();
    expect(await reportHealth(file, { problems: [chinos], checked, now: minutes(0) }, send, { save: false })).toBe('sent');
    expect(existsSync(file)).toBe(false);
  });

  it('links the GitHub Actions run when there is one', () => {
    expect(runLogUrl({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '7' }))
      .toBe('https://github.com/o/r/actions/runs/7');
    expect(runLogUrl({})).toBeUndefined();
  });
});

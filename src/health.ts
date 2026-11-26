import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { escapeHtml } from './notifier';

/** Something you should hear about: a watch that can't be read, a crashed run, a failed step. */
export interface Problem {
  /** The same problem across runs: a tracker id, or RUN / WORKFLOW. */
  readonly key: string;
  /** Who it is about, in messages: the tracker's label, or EVERY_WATCH. */
  readonly label: string;
  /** What went wrong, e.g. "Zara product request failed: HTTP 403". */
  readonly detail: string;
}

/** The run itself stopped (a crash, an invalid config): no watch was checked. */
export const RUN = 'run';
/** A workflow step around the run failed (install, tests): no watch was checked. */
export const WORKFLOW = 'workflow';
export const EVERY_WATCH = 'Every watch';

export interface OpenProblem {
  readonly label: string;
  readonly detail: string;
  /** When it was first seen. */
  readonly since: string;
  /** When you were last told about it; absent until a report was delivered. */
  readonly reportedAt?: string;
}

/** state/health.json: what is broken, and what you have been told about it. */
export interface HealthState {
  readonly problems: Readonly<Record<string, OpenProblem>>;
  /** When the watches were last checked, to notice checks that came late. */
  readonly checkedAt?: string;
  /** When you were last told that checks came late. */
  readonly lateNoticeAt?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A problem that lasts is repeated this often, so it is not forgotten. */
export const REMIND_AFTER_MS = 12 * HOUR;
/** Checks run about every 30 minutes; a gap this long means some never ran. */
export const LATE_AFTER_MS = 2 * HOUR;
/** Late checks are mentioned at most this often. */
export const LATE_NOTICE_EVERY_MS = 24 * HOUR;
/** Error text is unbounded (a config error lists every issue); keep a message readable. */
const DETAIL_LENGTH = 300;

export interface HealthInput {
  readonly problems: readonly Problem[];
  /** What this run would have seen failing: anything here but not in `problems` is fixed. */
  readonly checked: ReadonlySet<string>;
  /** What still exists; any other problem is dropped without a word (a removed watch). Omit to keep all. */
  readonly known?: ReadonlySet<string>;
  /** This run checked the watches, so it counts towards noticing late checks. */
  readonly checks?: boolean;
  readonly now: Date;
  /** This run's log, linked from problem reports. */
  readonly runUrl?: string;
}

export interface HealthReport {
  /** The Telegram message to send, when there is news. */
  readonly message?: string;
  /** Save this once the message is delivered, or straight away when there is none. */
  readonly delivered: HealthState;
  /** Save this when the message could not be delivered: it is then retried next run. */
  readonly undelivered: HealthState;
}

/** "45 min", "6 h 12 min", "3 days 4 h". */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  return `${Math.floor(hours / 24)} days${hours % 24 ? ` ${hours % 24} h` : ''}`;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_LENGTH ? `${flat.slice(0, DETAIL_LENGTH).trimEnd()}…` : flat;
}

const since = (from: string, now: number) => now - Date.parse(from);

/**
 * What to tell you about this run's problems: each one when it starts, again every 12 hours while it
 * lasts, and when it is fixed — all in one message. Plus a note, at most daily, when a check came
 * long after the previous one.
 */
export function planHealthReport(previous: HealthState, input: HealthInput): HealthReport {
  const now = input.now.toISOString();
  const nowMs = input.now.getTime();
  const current = new Map(input.problems.map((problem) => [problem.key, problem]));
  const failing: string[] = [];
  const fixed: string[] = [];
  const delivered: Record<string, OpenProblem> = {};
  const undelivered: Record<string, OpenProblem> = {};

  for (const problem of current.values()) {
    const open = previous.problems[problem.key];
    const record: OpenProblem = { label: problem.label, detail: problem.detail, since: open?.since ?? now };
    const line = (prefix: string) => `❌ <b>${escapeHtml(problem.label)}</b>${prefix}: ${escapeHtml(clip(problem.detail))}`;
    if (!open?.reportedAt) {
      failing.push(line(''));
      delivered[problem.key] = { ...record, reportedAt: now };
      undelivered[problem.key] = record;
    } else if (since(open.reportedAt, nowMs) >= REMIND_AFTER_MS) {
      failing.push(line(`, still failing after ${formatDuration(since(record.since, nowMs))}`));
      delivered[problem.key] = { ...record, reportedAt: now };
      undelivered[problem.key] = { ...record, reportedAt: open.reportedAt };
    } else {
      delivered[problem.key] = undelivered[problem.key] = { ...record, reportedAt: open.reportedAt };
    }
  }
  for (const [key, open] of Object.entries(previous.problems)) {
    if (current.has(key)) continue;
    if (input.checked.has(key)) {
      // Fixed. You only hear so if you heard it was broken; until that is delivered it stays open.
      if (open.reportedAt) {
        fixed.push(`✅ <b>${escapeHtml(open.label)}</b>: working again`);
        undelivered[key] = open;
      }
    } else if (!input.known || input.known.has(key)) {
      delivered[key] = undelivered[key] = open; // not looked at this run: no news
    }
  }

  let late: string | undefined;
  if (input.checks && previous.checkedAt) {
    const gap = since(previous.checkedAt, nowMs);
    // A run that stopped, or a failing step, already explains a gap, and you were told about it.
    const explained = Boolean(previous.problems[RUN] ?? previous.problems[WORKFLOW]);
    const toldRecently = previous.lateNoticeAt !== undefined &&
      since(previous.lateNoticeAt, nowMs) < LATE_NOTICE_EVERY_MS;
    if (gap >= LATE_AFTER_MS && !explained && !toldRecently) {
      late = `⏰ This check ran ${formatDuration(gap)} after the previous one instead of ~30 minutes, so a ` +
        'restock in between could have been missed: GitHub did not start the checks in between. If this ' +
        'keeps happening, make sure the <code>check-interval</code> environment has a 30-minute wait ' +
        'timer (repository Settings → Environments).';
    }
  }

  const checkedAt = input.checks ? now : previous.checkedAt;
  const state = (problems: Record<string, OpenProblem>, lateNoticeAt: string | undefined): HealthState => ({
    problems, ...(checkedAt ? { checkedAt } : {}), ...(lateNoticeAt ? { lateNoticeAt } : {}),
  });
  const headline = failing.length ? '⚠️ <b>Price Tracker — something is wrong</b>'
    : fixed.length ? '✅ <b>Price Tracker — fixed</b>'
    : late ? '⏰ <b>Price Tracker — checks were late</b>' : undefined;
  const log = failing.length && input.runUrl ? `<a href="${escapeHtml(input.runUrl)}">Run log</a>` : '';
  return {
    ...(headline ? { message: [headline, ...failing, ...fixed, late, log].filter(Boolean).join('\n') } : {}),
    delivered: state(delivered, late ? now : previous.lateNoticeAt),
    undelivered: state(undelivered, previous.lateNoticeAt),
  };
}

function isOpenProblem(value: unknown): value is OpenProblem {
  const entry = value as Partial<OpenProblem> | null;
  return typeof entry?.label === 'string' && typeof entry.detail === 'string' && typeof entry.since === 'string' &&
    (entry.reportedAt === undefined || typeof entry.reportedAt === 'string');
}

/** The saved health, or a clean slate when the file is missing or unreadable. */
export function loadHealth(path: string): HealthState {
  if (!existsSync(path)) return { problems: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HealthState> | null;
    const problems = parsed?.problems && typeof parsed.problems === 'object' ? parsed.problems : {};
    const time = (value: unknown) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined);
    const checkedAt = time(parsed?.checkedAt);
    const lateNoticeAt = time(parsed?.lateNoticeAt);
    return {
      problems: Object.fromEntries(Object.entries(problems).filter(([, entry]) => isOpenProblem(entry))),
      ...(checkedAt ? { checkedAt } : {}), ...(lateNoticeAt ? { lateNoticeAt } : {}),
    };
  } catch {
    return { problems: {} };
  }
}

export function saveHealth(path: string, health: HealthState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(health, null, 2)}\n`, 'utf8');
}

/** This GitHub Actions run's page, when running there. */
export function runLogUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: id } = env;
  return server && repo && id ? `${server}/${repo}/actions/runs/${id}` : undefined;
}

/** Tell you what changed since the last report, and record what you were told. */
export async function reportHealth(
  path: string,
  input: HealthInput,
  send: (html: string) => Promise<void>,
  options: { readonly save: boolean },
): Promise<'sent' | 'quiet' | 'failed'> {
  const report = planHealthReport(loadHealth(path), input);
  let outcome: 'sent' | 'quiet' | 'failed' = 'quiet';
  if (report.message) {
    try {
      await send(report.message);
      outcome = 'sent';
    } catch (error) {
      outcome = 'failed';
      console.warn(`⚠️  problem report failed: ${(error as Error).message}`);
    }
  }
  if (options.save) saveHealth(path, outcome === 'failed' ? report.undelivered : report.delivered);
  return outcome;
}

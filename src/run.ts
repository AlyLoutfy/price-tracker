import 'dotenv/config'; // load .env when running locally (no-op in CI, which sets real env vars)
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, loadTrackers } from './config';
import { collectListings } from './sources';
import { notify } from './notifier';
import { loadState, pruneState, saveState } from './state';
import { describeError, failureReason, trackLink, type TrackDeps, type TrackOutcome } from './track';
import { createAsicsCollector } from './asics';
import { createNikeCollector } from './nike';
import { createZaraCollector } from './zara';
import { isNikeProductUrl } from './parsers/nike';
import { isZaraProductUrl } from './parsers/zara';
import { trackProduct, trackStock } from './products';
import { EVERY_WATCH, reportHealth, RUN, runLogUrl, WORKFLOW, type Problem } from './health';

const STATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'state');
const STATE_PATH = resolve(STATE_DIR, 'seen.json');
const HEALTH_PATH = resolve(STATE_DIR, 'health.json');

async function main(): Promise<void> {
  // Without Telegram there is nowhere to report anything: this fails the job, and GitHub shows it.
  const env = loadEnv();
  const deps: TrackDeps = {
    collect: collectListings,
    send: (html, options) => notify(env, html, options),
  };
  const problems: Problem[] = [];
  // If this runs at all, the workflow steps before it (install, tests) passed.
  const checked = new Set([RUN, WORKFLOW]);
  let known: Set<string> | undefined;
  let failure: string | undefined;
  try {
    const configuredTrackers = loadTrackers();
    const trackers = configuredTrackers.filter((tracker) => tracker.enabled !== false);
    known = new Set([RUN, WORKFLOW, ...trackers.map((tracker) => tracker.id)]);
    const state = loadState(STATE_PATH);
    // Paused watches retain their history so re-enabling one cannot resend old ads.
    pruneState(state, new Set(configuredTrackers.map((tracker) => tracker.id)));
    for (const tracker of configuredTrackers) {
      if (tracker.enabled === false) console.log(`⏸ ${tracker.id}: disabled; history preserved`);
    }

    const outcomes: TrackOutcome[] = [];
    const collectAsics = createAsicsCollector();
    const collectNike = createNikeCollector();
    const collectZara = createZaraCollector();
    const collectProduct = (url: string) =>
      isNikeProductUrl(url) ? collectNike(url) : isZaraProductUrl(url) ? collectZara(url) : collectAsics(url);
    try {
      for (const tracker of trackers) {
        const product = { collect: collectProduct, send: deps.send };
        const outcome = tracker.mode === 'discount' ? await trackProduct(tracker, state, product)
          : tracker.mode === 'stock' ? await trackStock(tracker, state, product)
          : await trackLink(tracker, state, deps);
        outcomes.push(outcome);
        checked.add(tracker.id);
        if (outcome.kind === 'failed') {
          problems.push({ key: tracker.id, label: tracker.label, detail: outcome.error ?? 'could not be read' });
        }
      }
    } finally {
      // Persist whatever progress we made, even if something above threw — never lose bookkeeping.
      if (!env.dryRun) saveState(STATE_PATH, state);
    }

    const count = (kind: TrackOutcome['kind']) =>
      outcomes.filter((outcome) => outcome.kind === kind).length;
    const sent = outcomes.reduce((sum, outcome) => sum + outcome.sent, 0);
    const sendFailures = outcomes.reduce((sum, outcome) => sum + outcome.sendFailures, 0);
    console.log(
      `\nDone. ${sent} message(s) sent, ${count('seed')} seeded, ${count('resync')} resynced, ` +
        `${count('failed')} link(s) unreadable, ${sendFailures} send failure(s).`,
    );
    failure = failureReason(outcomes);
  } catch (error) {
    // A crash or an invalid config stops every watch until it is fixed. Watches not reached keep
    // whatever problems they had.
    console.error('Fatal:', error);
    problems.push({ key: RUN, label: EVERY_WATCH, detail: `the run stopped: ${describeError(error)}` });
    known = undefined;
    failure = 'the run stopped before every watch was checked';
  }

  const report = await reportHealth(HEALTH_PATH,
    { problems, checked, known, checks: true, now: new Date(), runUrl: runLogUrl() },
    (html) => deps.send(html, { preview: false }), { save: !env.dryRun });
  if (report === 'sent') console.log('📣 problem report sent');

  if (failure) {
    console.error(`✗ ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('Fatal:', error);
  process.exit(1);
});

import 'dotenv/config'; // load .env when running locally (no-op in CI, which sets real env vars)
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, loadTrackers } from './config';
import { collectListings } from './sources';
import { notify } from './notifier';
import { loadState, pruneState, saveState } from './state';
import { failureReason, trackLink, type TrackDeps, type TrackOutcome } from './track';
import { createAsicsCollector } from './asics';
import { trackProduct } from './products';

const STATE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'state', 'seen.json');

async function main(): Promise<void> {
  const env = loadEnv();
  const trackers = loadTrackers();
  const state = loadState(STATE_PATH);
  pruneState(state, new Set(trackers.map((tracker) => tracker.id)));

  const deps: TrackDeps = {
    collect: collectListings,
    send: (html, options) => notify(env, html, options),
  };
  const outcomes: TrackOutcome[] = [];
  const collectProduct = createAsicsCollector();
  try {
    for (const tracker of trackers) {
      outcomes.push(tracker.mode === 'discount'
        ? await trackProduct(tracker, state, {
            collect: collectProduct,
            send: deps.send,
          })
        : await trackLink(tracker, state, deps));
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

  const reason = failureReason(outcomes);
  if (reason) {
    console.error(`✗ ${reason}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('Fatal:', error);
  process.exit(1);
});

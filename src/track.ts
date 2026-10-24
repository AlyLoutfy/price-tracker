import type { Listing, Match, TrackerConfig } from './types';
import { applyFilters } from './filters';
import { marketPeers } from './market';
import { formatDigestMessage, formatListingMessage } from './notifier';
import { keysToPersist, reconcile } from './reconcile';
import { isRepost, offerOf } from './reposts';
import { getOffers, getSeen, mergeSeen, setSeen, type SeenState } from './state';

/** The I/O one tracker run needs, injected so the bookkeeping below can be tested offline. */
export interface TrackDeps {
  readonly collect: (url: string) => Promise<Listing[]>;
  readonly send: (html: string, options?: { preview?: boolean }) => Promise<void>;
}

export interface TrackOutcome {
  /** `failed` — the link couldn't be read this run; its state was left untouched. */
  readonly kind: 'failed' | 'seed' | 'resync' | 'diff';
  readonly matches: number;
  readonly sent: number;
  readonly sendFailures: number;
  /** New ads not alerted because they repeat an offer already seen (a repost). */
  readonly reposts?: number;
}

/** Keep the first match of each offer, so a repost doesn't show up twice in one message. */
function uniqueOffers(matches: readonly Match[], offers: ReadonlyMap<string, string>): Match[] {
  const seen: string[] = [];
  return matches.filter((match) => {
    const offer = offers.get(match.listing.key);
    if (offer && isRepost(offer, seen)) return false;
    if (offer) seen.push(offer);
    return true;
  });
}

/**
 * Check one tracked link: fetch it, filter, work out what's new, message about it, and record in
 * `state` exactly what was handled. Never throws — a failure is reported in the outcome.
 */
export async function trackLink(
  tracker: TrackerConfig,
  state: SeenState,
  deps: TrackDeps,
): Promise<TrackOutcome> {
  let matches;
  try {
    matches = applyFilters(await deps.collect(tracker.url), tracker);
  } catch (error) {
    // Fetch/parse/validation failure: leave this tracker's state untouched and retry next run.
    console.warn(`⚠️  ${tracker.id}: ${(error as Error).message}`);
    return { kind: 'failed', matches: 0, sent: 0, sendFailures: 0 };
  }

  const currentKeys = matches.map((match) => match.listing.key);
  const previous = getSeen(state, tracker.id, tracker.url);
  const previousOffers = getOffers(state, tracker.id, tracker.url);
  const plan = reconcile(previous, matches);
  const peers = marketPeers(matches);

  const currentOffers = new Map<string, string>();
  for (const match of matches) {
    const offer = offerOf(match, tracker.compareBy);
    if (offer) currentOffers.set(match.listing.key, offer);
  }
  const allOffers = { ...previousOffers, ...Object.fromEntries(currentOffers) };

  if (plan.kind === 'seed') {
    // A new (or edited) link: one digest of what's on the market now, not an alert per ad.
    // Recorded even if the digest fails to send — retrying it would mean alerting every ad.
    setSeen(state, tracker.id, tracker.url, currentKeys, allOffers);
    try {
      const digest = formatDigestMessage(tracker, uniqueOffers(matches, currentOffers), peers);
      await deps.send(digest, { preview: false });
      console.log(`🌱 seeded ${tracker.id} with ${matches.length} match(es)`);
      return { kind: 'seed', matches: matches.length, sent: 1, sendFailures: 0 };
    } catch (error) {
      console.warn(`⚠️  digest failed for ${tracker.id}: ${(error as Error).message}`);
      return { kind: 'seed', matches: matches.length, sent: 0, sendFailures: 1 };
    }
  }

  if (plan.kind === 'resync') {
    // The whole page suddenly looks new (state loss / parser recovery): record silently.
    setSeen(state, tracker.id, tracker.url, mergeSeen(previous ?? [], currentKeys), allOffers);
    console.warn(
      `🔁 resynced ${tracker.id}: all ${matches.length} match(es) looked new — ` +
        're-recorded without alerting',
    );
    return { kind: 'resync', matches: matches.length, sent: 0, sendFailures: 0 };
  }

  // Normal diff: alert the fresh matches, but only mark one seen once it has actually been handled
  // — alerted, or recognised as a repost. A failed send is retried on the next run, never lost.
  const freshKeys = new Set(plan.toAlert.map((match) => match.listing.key));
  // Every offer already seen: ads still listed, and ones since taken down (the usual way to "bump"
  // an ad is to delete it and post it again).
  const knownOffers = [
    ...Object.values(previousOffers),
    ...[...currentOffers].filter(([key]) => !freshKeys.has(key)).map(([, offer]) => offer),
  ];
  const handled = new Set<string>();
  let sent = 0;
  let reposts = 0;
  let sendFailures = 0;
  for (const match of plan.toAlert) {
    const offer = currentOffers.get(match.listing.key);
    if (offer && isRepost(offer, knownOffers)) {
      handled.add(match.listing.key);
      reposts += 1;
      console.log(`🔁 repost skipped ${tracker.id}: ${match.listing.title} — ${match.listing.url}`);
      continue;
    }
    try {
      await deps.send(formatListingMessage(tracker, match, peers));
      handled.add(match.listing.key);
      sent += 1;
      if (offer) knownOffers.push(offer); // a second copy posted in the same hour is a repost too
      console.log(`🔔 NEW ${tracker.id}: ${match.listing.title} — ${match.listing.url}`);
    } catch (error) {
      sendFailures += 1;
      console.warn(
        `⚠️  alert failed for ${tracker.id} (${match.listing.title}): ${(error as Error).message}`,
      );
    }
  }

  const persistable = keysToPersist(currentKeys, freshKeys, handled);
  setSeen(state, tracker.id, tracker.url, mergeSeen(previous ?? [], persistable), allOffers);
  console.log(
    `✓ ${tracker.id}: ${matches.length} match(es), ${sent} alerted, ${reposts} repost(s) skipped`,
  );
  return { kind: 'diff', matches: matches.length, sent, sendFailures, reposts };
}

/**
 * Why this run should fail the job, if it should. A failed job is how GitHub tells you (by email)
 * that something is broken; a run that quietly logs warnings every hour tells you nothing.
 */
export function failureReason(outcomes: readonly TrackOutcome[]): string | undefined {
  if (outcomes.length > 0 && outcomes.every((outcome) => outcome.kind === 'failed')) {
    return 'no tracked link could be read — the site may be blocking requests or have changed';
  }
  if (outcomes.some((outcome) => outcome.kind === 'failed')) {
    return 'one or more tracked links could not be read — see warnings; successfully handled alerts and state were preserved';
  }
  const attempted = outcomes.reduce((sum, outcome) => sum + outcome.sent + outcome.sendFailures, 0);
  const failed = outcomes.reduce((sum, outcome) => sum + outcome.sendFailures, 0);
  if (failed > 0 && failed === attempted) {
    return 'every Telegram message failed — check TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID';
  }
  return undefined;
}

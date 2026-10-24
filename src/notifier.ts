import type { AppEnv } from './config';
import type { Check, Match, TrackerConfig } from './types';
import { totalCost } from './filters';
import { marketPosition, type MarketPosition, type Verdict } from './market';
import { sendTelegramMessage } from './telegram';

const CHECK_ICONS: Record<Check['status'], string> = {
  pass: '✅',
  warn: '⚠️',
  unknown: '❓',
  fail: '❌',
};

const VERDICT_LABELS: Record<Verdict, string> = {
  great: '🔥 Great deal',
  good: '👍 Good price',
  fair: '➖ Fair price',
  high: '👎 Above market',
};

/** Telegram rejects messages over 4096 characters; stay well clear of it. */
const MAX_MESSAGE_LENGTH = 3800;
const DIGEST_SIZE = 10;
// Seller-written text is unbounded; clip it so no ad can push a message past Telegram's limit (a
// rejected message would be retried, and rejected, every run — the ad would never reach you).
const EXCERPT_LENGTH = 220;
const TITLE_LENGTH = 120;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const egp = (amount: number): string => `${Math.round(amount).toLocaleString('en-US')} EGP`;

/** "Storage: 256 GB · Kilometers: 61,000" from the attributes a tracker asked to show. */
function formatDetails(tracker: TrackerConfig, match: Match): string {
  return (tracker.details ?? [])
    .map((label) => {
      const value = match.listing.attributes[label];
      if (!value) return undefined;
      // 61000 → 61,000, but leave short numbers (a year, a 4-digit engine size) alone.
      const shown = /^\d{5,}$/.test(value) ? Number(value).toLocaleString('en-US') : value;
      return `${label}: ${shown}`;
    })
    .filter(Boolean)
    .join(' · ');
}

function formatCost(match: Match): string {
  const price = match.listing.priceEgp;
  if (price == null) return 'Price N/A';
  if (match.extraCostEgp > 0) {
    const total = egp(price + match.extraCostEgp);
    return `${egp(price)} + ${egp(match.extraCostEgp)} tax = <b>${total}</b>`;
  }
  if (match.possibleExtraCostEgp > 0) {
    return `${egp(price)} (${egp(price + match.possibleExtraCostEgp)} if tax is owed)`;
  }
  return egp(price);
}

function formatChecks(checks: readonly Check[]): string {
  return checks
    .map((check) => `${CHECK_ICONS[check.status]} ${check.label}: ${check.detail}`)
    .join('  ·  ');
}

function relativeToMedian(position: MarketPosition): string {
  const percent = Math.round(Math.abs(position.vsMedian) * 100);
  if (percent === 0) return 'right at the median';
  return `${percent}% ${position.vsMedian < 0 ? 'below' : 'above'} the median`;
}

function describePeers(position: MarketPosition): string {
  const scope = position.scope ? ` ${escapeHtml(position.scope)}` : '';
  return `${egp(position.medianEgp)} across ${position.peerCount} comparable${scope} ads`;
}

/** One or two lines placing the listing's total cost in its market; empty when there's no price. */
function formatMarket(tracker: TrackerConfig, match: Match, peers: readonly Match[]): string {
  const total = totalCost(match);
  if (total == null) return '';
  const at = (price: number) => marketPosition(price, match, peers, tracker.compareBy);

  if (match.possibleExtraCostEgp > 0) {
    const ifClear = at(total);
    const ifOwed = at(total + match.possibleExtraCostEgp);
    if (!ifClear || !ifOwed) return '';
    return [
      `📊 If tax-free: ${VERDICT_LABELS[ifClear.verdict]} — ${relativeToMedian(ifClear)}`,
      `     If tax is owed: ${VERDICT_LABELS[ifOwed.verdict]} — ${relativeToMedian(ifOwed)}`,
      `     (median ${describePeers(ifClear)})`,
    ].join('\n');
  }

  const position = at(total);
  if (!position) return '';
  const cheaper = Math.round(position.cheaperThan * 100);
  return (
    `📊 ${VERDICT_LABELS[position.verdict]} — ${relativeToMedian(position)} ` +
    `(${describePeers(position)}; cheaper than ${cheaper}% of them)`
  );
}

/** Collapse whitespace and cut to `max` characters, marking the cut. */
function clip(text: string | null, max: number): string {
  const flat = text?.replace(/\s+/g, ' ').trim() ?? '';
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/**
 * The Telegram HTML message for one newly-posted listing. `peers` is the comparable market
 * (see `marketPeers`) the listing's price is judged against.
 */
export function formatListingMessage(
  tracker: TrackerConfig,
  match: Match,
  peers: readonly Match[] = [],
): string {
  const { listing } = match;
  // Telegram previews the FIRST link in a message, so a zero-width anchor on the thumbnail puts the
  // photo above the text. Invisible when there is no image to show.
  const photo = listing.imageUrl ? `<a href="${escapeHtml(listing.imageUrl)}">&#8203;</a>` : '';
  const details = formatDetails(tracker, match);
  const quote = clip(listing.description, EXCERPT_LENGTH);

  return [
    `${photo}🔔 <b>New match — ${escapeHtml(tracker.label)}</b>`,
    `<b>${escapeHtml(clip(listing.title, TITLE_LENGTH))}</b>`,
    details && `📋 ${escapeHtml(details)}`,
    `💰 ${formatCost(match)}`,
    match.checks.length ? formatChecks(match.checks) : '',
    formatMarket(tracker, match, peers),
    quote && `💬 <i>${escapeHtml(quote)}</i>`,
    `🔗 <a href="${escapeHtml(listing.url)}">View listing</a>`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The one message sent when a link is first tracked: how many ads match right now, and the best
 * value among them — so adding a link gives you the current market instead of silence.
 *
 * Ranked by worst-case total cost: an ad that doesn't mention tax is ranked as if it's owed, so a
 * suspiciously cheap "maybe taxed" phone can't crowd out ones you know the real price of.
 */
export function formatDigestMessage(
  tracker: TrackerConfig,
  matches: readonly Match[],
  peers: readonly Match[] = [],
): string {
  const worstCase = (match: Match): number =>
    (totalCost(match) ?? Number.POSITIVE_INFINITY) + match.possibleExtraCostEgp;
  const ranked = [...matches].sort((a, b) => worstCase(a) - worstCase(b));

  const header = [
    `🆕 <b>Now tracking — ${escapeHtml(tracker.label)}</b>`,
    matches.length === 0
      ? 'Nothing matches right now. You’ll get a message as soon as something does.'
      : `${matches.length} ad${matches.length === 1 ? '' : 's'} match right now. Best value:`,
  ].join('\n');

  const lines: string[] = [];
  let length = header.length;
  for (const [index, match] of ranked.slice(0, DIGEST_SIZE).entries()) {
    const details = formatDetails(tracker, match);
    const total = totalCost(match);
    const position =
      total != null && match.possibleExtraCostEgp === 0
        ? marketPosition(total, match, peers, tracker.compareBy)
        : null;
    const line = [
      `${index + 1}. <a href="${escapeHtml(match.listing.url)}">` +
        `${escapeHtml(clip(match.listing.title, TITLE_LENGTH))}</a>` +
        (details ? ` · ${escapeHtml(details)}` : ''),
      `     💰 ${formatCost(match)}` +
        (position ? ` · ${VERDICT_LABELS[position.verdict]} (${relativeToMedian(position)})` : ''),
      match.checks.length ? `     ${formatChecks(match.checks)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (length + line.length > MAX_MESSAGE_LENGTH) break;
    lines.push(line);
    length += line.length + 1;
  }

  const more = matches.length - lines.length;
  const footer =
    more > 0 ? `…and ${more} more. From now on you’ll get a message for each new ad.` : '';
  return [header, ...lines, footer].filter(Boolean).join('\n');
}

export async function notify(
  env: AppEnv,
  html: string,
  options: { preview?: boolean } = {},
): Promise<void> {
  if (env.dryRun) {
    console.log(`[dry-run] would send:\n${html}\n`);
    return;
  }
  await sendTelegramMessage(env, html, options);
}

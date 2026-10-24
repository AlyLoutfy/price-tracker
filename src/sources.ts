import type { Listing, ParsedPage } from './types';
import { fetchDirect } from './fetchers';
import { fetchBrowser } from './browser';
import { dubizzlePageUrl, parseDubizzle } from './parsers/dubizzle';

interface SiteAdapter {
  readonly name: string;
  /** A token that must appear in a genuine results page (used to reject broken/challenge pages). */
  readonly pageMarker: string;
  /** `sourceUrl` is the URL the content came from; parsers may use it for make/model. */
  readonly parse: (content: string, sourceUrl: string) => ParsedPage;
  /** The URL of page `page` (1-based) of the search at `url`. */
  readonly pageUrl: (url: string, page: number) => string;
  /** Override the request timeout — a full listings page can be several MB. */
  readonly timeoutMs?: number;
}

// Keyed by hostname (without "www."). To support another site, add a parser under src/parsers/
// and register it here.
const ADAPTERS: Record<string, SiteAdapter> = {
  // Dubizzle embeds listing data in its initial HTML, but may require a JavaScript challenge
  // before serving it. The browser fallback keeps that original response intact.
  'dubizzle.com.eg': {
    name: 'Dubizzle',
    pageMarker: 'dubizzle.com.eg',
    parse: parseDubizzle,
    pageUrl: dubizzlePageUrl,
    timeoutMs: 70_000,
  },
};

/** Stop following pagination here: a search this broad wants narrowing on the site itself. */
const MAX_PAGES = 10;

export function siteFor(url: string): SiteAdapter {
  const host = new URL(url).hostname.replace(/^www\./, '');
  const adapter = ADAPTERS[host];
  if (!adapter) {
    const supported = Object.keys(ADAPTERS).join(', ');
    throw new Error(`${host} is not a supported site (supported: ${supported})`);
  }
  return adapter;
}

// Markers that mean we got a bot-challenge / error page rather than real content. A page like
// this must NOT be parsed as "zero listings" — that would poison the seen-state.
const CHALLENGE_MARKERS = [
  'just a moment',
  'cf-chl',
  'attention required',
  'enable javascript and cookies',
  'access denied',
];

/**
 * Reject a response that does not look like a real results page, so a broken fetch (truncated
 * reply, Cloudflare challenge, site outage returning HTTP 200) is treated as a failure to retry —
 * never as a legitimately-empty result that would seed an empty set or trigger a mass re-alert.
 */
export function assertResultsPage(site: SiteAdapter, content: string): void {
  const lower = content.toLowerCase();
  if (content.length < 800) {
    throw new Error(`${site.name}: response too short (${content.length} chars) — likely a failed fetch`);
  }
  if (!lower.includes(site.pageMarker)) {
    throw new Error(`${site.name}: response missing expected marker "${site.pageMarker}"`);
  }
  const challenge = CHALLENGE_MARKERS.find((marker) => lower.includes(marker));
  if (challenge) {
    throw new Error(`${site.name}: looks like a bot-challenge page ("${challenge}")`);
  }
}

/**
 * Fetch, validate and parse every result page of a tracked link.
 *
 * All pages or nothing: if any page fails, the whole link is skipped this run. A partial result
 * set would skew the market comparison and look like listings disappearing.
 */
export async function collectListings(url: string): Promise<Listing[]> {
  const site = siteFor(url);
  const byKey = new Map<string, Listing>();

  let totalPages = 1;
  for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page += 1) {
    const pageUrl = site.pageUrl(url, page);
    const validate = (html: string): void => {
      assertResultsPage(site, html);
      // A 200 response containing only challenge scripts must never become an empty search.
      site.parse(html, url);
    };
    let content: string;
    try {
      content = await fetchDirect(pageUrl, { timeoutMs: site.timeoutMs, retries: 0 });
      validate(content);
    } catch (error) {
      console.warn(`↪ ${site.name}: direct fetch unavailable (${(error as Error).message}); trying browser`);
      content = await fetchBrowser(pageUrl, validate, site.timeoutMs);
    }
    const parsed = site.parse(content, url);
    if (page === 1) totalPages = parsed.totalPages;
    // A promoted ad can appear on several pages; the first sighting wins.
    for (const listing of parsed.listings) {
      if (!byKey.has(listing.key)) byKey.set(listing.key, listing);
    }
  }

  if (totalPages > MAX_PAGES) {
    console.warn(`⚠️  ${url}: ${totalPages} result pages — only the first ${MAX_PAGES} are read`);
  }
  return [...byKey.values()];
}

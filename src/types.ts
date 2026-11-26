/** A single listing, normalised from whatever site it came from. */
export interface Listing {
  /** Stable key used to detect whether we have already alerted on this listing. */
  readonly key: string;
  readonly title: string;
  readonly priceEgp: number | null;
  readonly url: string;
  readonly imageUrl: string | null;
  /** The seller's free-text description, or null when the page didn't carry it. */
  readonly description: string | null;
  /** The ad's structured fields by English label, e.g. { Year: '2022', Storage: '256 GB' }. */
  readonly attributes: Readonly<Record<string, string>>;
  /** The site's id for whoever posted the ad, when the page says — used to spot reposts. */
  readonly sellerId: string | null;
}

/** Everything one results page yielded. */
export interface ParsedPage {
  readonly listings: Listing[];
  /** How many result pages the search has in total (1 when unknown). */
  readonly totalPages: number;
}

/** Client-side narrowing applied after the site returns its listings. */
export interface TrackerFilters {
  /** Bounds on the total cost: the price plus any extra the ad says is owed (see `phoneTaxEgp`). */
  readonly priceMin?: number;
  readonly priceMax?: number;
  /** Every entry must appear (case-insensitively) in the listing title or description. */
  readonly titleMustInclude?: readonly string[];
  /** Drop ads whose description states a battery health below this percentage. */
  readonly minBatteryHealth?: number;
}

export type Currency = 'EUR' | 'EGP';

/** The colour (and size, when the link names one) a product tracker watches, as its store quotes it. */
export interface ProductSnapshot {
  readonly key: string;
  readonly title: string;
  readonly price: number;
  readonly currency: Currency;
  /** The store's own crossed-out full price, when it shows one (Zara during a sale). */
  readonly oldPrice?: number;
  /** The watched size is available, or (for a whole-colour watch) any size is. */
  readonly inStock: boolean;
  /** The store says only a few of the watched size are left (Zara). */
  readonly lowStock?: boolean;
  readonly color: string;
  /**
   * The watched size as the tracked link gives it (Zara: as Zara names it, e.g. "M"); absent when
   * the whole colour is watched.
   */
  readonly size?: string;
  /** The EU size shown to shoppers, e.g. "42.5" (ASICS, Nike); Zara's sizes have no EU label. */
  readonly sizeLabel?: string;
  /** Only for stores that sell several widths (ASICS). */
  readonly width?: string;
  /** The sizes of the colour available now (Zara). */
  readonly sizesInStock?: readonly string[];
  /** The product page alerts open, when it isn't the tracked link itself. */
  readonly pageUrl?: string;
  /** Where the alert's link opens, e.g. "ASICS France". */
  readonly store: string;
}

/** One link the user wants to be alerted about. */
export interface TrackerConfig {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  /** A disabled watch keeps its history but makes no requests or sends. */
  readonly enabled?: boolean;
  /**
   * Omitted for Dubizzle searches. `discount` watches one ASICS, Nike or Zara product colour for a
   * sale; `stock` watches one size of one for coming back in stock, at any price.
   */
  readonly mode?: 'listings' | 'discount' | 'stock';
  /** Starting full price of a discount tracker, in the store's currency (EUR, or EGP for Zara Egypt). */
  readonly referencePrice?: number;
  readonly filters?: TrackerFilters;
  /**
   * Egyptian customs tax on an imported phone. When set, each ad is read for whether the tax is
   * still owed, and this amount is added to the price of the ones that owe it — so a taxed phone is
   * judged on what it will actually cost you.
   */
  readonly phoneTaxEgp?: number;
  /** Attributes shown under the title in alerts, e.g. ["Year", "Kilometers"]. */
  readonly details?: readonly string[];
  /** Compare a listing's price only against ads sharing these attributes, e.g. ["Storage"]. */
  readonly compareBy?: readonly string[];
}

/**
 * The outcome of one description-based check. `unknown` means the ad didn't say — such a listing
 * is kept, on the principle that a listing you didn't want beats a listing you missed.
 */
export interface Check {
  readonly label: string;
  /** `warn` — kept, but worth your attention (e.g. tax still owed). */
  readonly status: 'pass' | 'warn' | 'fail' | 'unknown';
  readonly detail: string;
}

/** A listing that survived the tracker's filters, with the checks that let it through. */
export interface Match {
  readonly listing: Listing;
  readonly checks: readonly Check[];
  /** Cost the ad says the buyer still owes on top of the price (e.g. phone customs tax). */
  readonly extraCostEgp: number;
  /** Cost that may apply but the ad doesn't say either way (tax not mentioned). */
  readonly possibleExtraCostEgp: number;
}

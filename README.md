# Price Tracker

[Price Tracker](https://github.com/AlyLoutfy/price-tracker) watches Dubizzle Egypt searches for new
matching ads and ASICS France products for discounts. Alerts go to **Telegram**. Dubizzle alerts
include a market-price comparison; ASICS alerts show the old price, new price and saving in EUR.
It runs hourly on **GitHub Actions**, with no server or paid reader service.

Currently tracking:

| Tracker | Link | Extra rules |
|---------|------|-------------|
| SEAT Leon · 2021+ | [used Seat Leon, year ≥ 2021](https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/seat/model-leon/?filter=year_min_2021) | price 900k–1.51M EGP |
| ASICS GEL-VENTURE 6 · Black/Black | [1203A297-002](https://www.asics.com/fr/fr-fr/gel-venture-6/p/1203A297-002.html?size=9&width=Standard) | EU 42.5, Standard; alert below €100, when in stock |
| ASICS GEL-CHALLENGER 15 CLAY · Oatmeal/Midnight | [1041A508-250](https://www.asics.com/fr/fr-fr/gel-challenger-15-clay/p/1041A508-250.html?size=9&width=Standard) | EU 42.5, Standard; alert below €120, when in stock |
| ASICS GEL-EXCITE 11 · Foggy Teal/Ocean Haze | [1011C080-404](https://www.asics.com/fr/fr-fr/gel-excite-11/p/1011C080-404.html?size=9&width=Standard) | EU 42.5, Standard; alert below €90, when in stock |

ASICS reference prices were checked on 24 October 2026. URL size `9` maps to EU `42.5` on
ASICS France. Each colour/size/width combination is checked separately.

## Dubizzle listing alerts

```
GitHub Actions cron (hourly)
        │
        ▼
  fetch every page  ──►  parse ads  ──►  filter + read  ──►  diff against state/seen.json
  of each link           (price, text,   the description     (only genuinely NEW ads)
                          fields)        (tax, battery)             │
                                                                    ▼
                                       compare the price with ──►  Telegram message
                                       every other matching ad
        ▼
  commit updated state/seen.json
```

- **Any Dubizzle search works: cars, phones, anything.** Filter the search on the site, copy the
  URL, and add it to [`config/trackers.json`](config/trackers.json). The page embeds every ad
  with prices and structured fields like year and mileage. A direct request is tried first; if
  Dubizzle serves a JavaScript challenge or HTTP 503, Chromium loads the page in an isolated
  session. No API key or paid proxy is involved. The original document response is parsed because
  Dubizzle removes the embedded app state from the DOM after hydration.
- **You hear about the current market once.** When a link is first added (or edited), you get a
  single digest message: how many ads match right now and the best-value ones. After that you get
  one message per new ad.
- **Every alert is placed in its market.** Each new ad's price is compared with the median of the
  other matching ads, for example "🔥 Great deal — 12% below the median (60,000 EGP across 67
  comparable 256 GB ads)".
- **No duplicate alerts.** `state/seen.json` remembers every ad already seen (by Dubizzle's stable ad
  ID), and the Action commits it back after each run. An ad is only marked seen once its alert was
  actually delivered, so a transient Telegram failure is retried next run instead of dropped.
- **No repost alerts.** Sellers bump an ad by posting it again under a new ID. The tracker also
  remembers who posted each ad, for which variant (`compareBy`) and at what price. A "new" ad from
  the same seller, for the same variant, within 5% of a price already seen is recorded without an
  alert, even if the original was taken down first. A real price drop still alerts.
- **No spam on breakage.** A failed fetch or a bot-challenge page is detected and skipped (state
  untouched, retried next run) instead of being mistaken for "zero ads". If a whole page suddenly
  looks new (state loss, a parser recovering after a site redesign), it's re-recorded silently.
- **Loud on a real outage.** If any tracked link remains unreadable after the browser fallback,
  or every Telegram message fails, the run fails and GitHub can notify you. Successful alerts and
  their state are still saved, and every tracker is retried next hour. ASICS success cannot hide a
  failed Dubizzle search. Individual failed messages are also retried.

## ASICS discount alerts

ASICS blocks plain product-page requests. The tracker uses the same public Salesforce Shopper
Products API as the ASICS storefront, with an anonymous guest session. No personal ASICS account,
API secret, browser installation or paid subscription is needed. Guest tokens live only in memory.

- The price and stock must match the product code, colour, size and width in your link. A sale on
  another colour or size does not trigger an alert.
- An undiscounted first check quietly records the baseline. An existing discount alerts immediately.
- A price below `referencePrice` alerts when your variant is in stock. An out-of-stock sale is
  recorded and alerts if that size becomes available while still discounted.
- The same sale is sent once. A further price drop alerts again. Price rises within a sale stay quiet.
  After the product returns to full price, a later sale can alert again.
- A failed Telegram delivery is retried next run. A failed product fetch leaves its previous state
  untouched. Prices and alert delivery state are saved alongside the existing listing history.
- Only public product prices are checked; checkout-only codes, shipping and member-only offers are
  not included. The initial full price is explicit in configuration, so a first-fetch error cannot
  silently establish a wrong baseline.

## The market comparison

- **Peers.** Each alert compares the ad's total cost with every other ad that passed the same
  filters in this run (all result pages). Ads whose total is uncertain (tax not mentioned) are left
  out of the reference, because their real price could be either of two numbers.
- **`compareBy`.** Narrows peers to ads sharing an attribute (`["Storage"]`: a 512 GB phone isn't
  priced like a 256 GB one). It widens back to the whole market when fewer than 5 ads share it.
- **Junk prices.** Placeholder prices ("1 EGP") and "wanted" ads are trimmed before the median is
  taken.
- **Verdicts.** 🔥 ≥10% below the median · 👍 4–10% below · ➖ within ±4% · 👎 above.

It compares against the listed fields only: a car with 120,000 km and one with 20,000 km of the same
year count as peers. Check the mileage in the alert.

## 1. Local quick start

```bash
nvm use            # Node 20+
npm install
npx playwright install --with-deps --no-shell chromium
npm run dry-run    # fetches the live links and prints what WOULD be sent — sends nothing
npm test           # unit + parser tests (offline, uses captured fixtures)
npm run test:browser # real Chromium tests against a local challenge server
npm run telegram:test # sends one connection test using the configured bot
```

## 2. Create your Telegram bot (2 minutes)

1. In Telegram, message **@BotFather** → send `/newbot` → follow the prompts → copy the **bot token**.
2. Send your new bot any message (e.g. "hi") so it can message you back.
3. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and copy the
   `"chat":{"id": ... }` number. That's your **chat ID**.

Test it locally:

```bash
cp .env.example .env     # then fill in the two values
npm start                # first run sends one digest per link; later runs alert on new ads
```

## 3. Deploy on GitHub Actions (the cron job)

1. Push this repo to GitHub.
2. **Settings → Secrets and variables → Actions → New repository secret**, add
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Those are the only secrets the workflow needs.
3. **Settings → Actions → General → Workflow permissions** → enable **Read and write permissions**
   (so the job can commit `state/seen.json` back).
4. The workflow [`.github/workflows/tracker.yml`](.github/workflows/tracker.yml) runs hourly. You
   can also trigger it from the **Actions** tab (**Run workflow**). Select **test_telegram** to
   send only a connection test; leave it unchecked for a normal tracking run. Tests and typechecking
   run before either action.

## 4. Track a link

Add a Dubizzle search to [`config/trackers.json`](config/trackers.json):

```jsonc
{
  "id": "seat-leon-2021",            // unique, stable key for saved history
  "label": "SEAT Leon · 2021+",       // shown in alerts
  "url": "https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/seat/model-leon/?filter=year_min_2021",
  "filters": {
    "priceMin": 900000,
    "priceMax": 1510000
  },
  "details": ["Kilometers"],
  "compareBy": ["Year"]
}
```

- Build the `url` by filtering on Dubizzle itself (make, model, year, mileage), then copying the
  address bar. The site does the heavy filtering; `filters` narrows further.
- `details` and `compareBy` take the field names Dubizzle shows on an ad: `Year`, `Kilometers`,
  `Transmission Type`, `Storage`, `RAM`, …
- Editing a tracker's `url` makes it a new search: it re-seeds with a fresh digest instead of
  alerting every ad the new link happens to include.
- Unknown options are rejected at startup, so a typo like `minBateryHealth` fails loudly instead of
  silently not filtering.

For an ASICS France product, keep the exact size and width in the URL and set its starting full
price in EUR:

```json
{
  "id": "asics-gel-venture-6",
  "label": "ASICS GEL-VENTURE 6 · Black/Black · EU 42.5 · Standard",
  "mode": "discount",
  "url": "https://www.asics.com/fr/fr-fr/gel-venture-6/p/1203A297-002.html?size=9&width=Standard",
  "referencePrice": 100
}
```

Listing filters, customs tax and market comparison options do not apply to discount trackers.
Editing a product URL or reference price resets its sale comparison.

## Limitations & maintenance

- **Supported sites.** Dubizzle Egypt searches and ASICS France product links. Other sites and
  ASICS locales are rejected at startup.
- **Dubizzle challenges.** HTTP 503 or a challenge-only HTTP 200 triggers the browser fallback.
  A page is accepted only when it contains actual listing data or explicitly reports zero results.
  An unfinished challenge leaves the previous seen history intact.
- **Scraping is inherently brittle.** The parser reads three independent copies of the result set
  (the page's app state, its schema.org JSON-LD, and its analytics ad-id arrays), so one of them
  changing shape degrades gracefully. The description only comes from the app state, though: if it
  disappears, the tax/battery checks see "not mentioned" and every phone is sent. Run
  `npm run dry-run` to see what each link currently returns.
- **A site can start blocking us.** Browser loading can also fail if Dubizzle changes its checks
  or has an outage. An unreadable link fails the job after the other trackers have been checked;
  it is retried next hour without losing history.
- **GitHub cron caveats.** Scheduled runs can be delayed under load, and GitHub auto-disables
  schedules after ~60 days of no repo activity (the state commits keep it active).

## Project layout

```
config/trackers.json     the links you want to track
src/
  run.ts                 entry point: runs every tracker, saves state, fails the job on an outage
  asics.ts               anonymous guest session and live ASICS product API
  products.ts            discount comparison, EUR alert formatting and delivery bookkeeping
  parsers/asics.ts       exact colour/size/width quote and stock parsing
  test-telegram.ts       send a single Telegram connection test
  track.ts               one link per run: fetch → filter → reconcile → notify → record what's handled
  sources.ts             site registry; fetches every result page; rejects broken/challenge pages
  fetchers.ts            direct page fetch with retry/backoff
  browser.ts             isolated Chromium fallback; preserves the original document response
  parsers/dubizzle.ts    app state + JSON-LD + ad-id arrays → listings
  signals.ts             reads tax status and battery health out of ad descriptions
  filters.ts             price / keyword / battery filters; adds tax owed to the total cost
  market.ts              median, rank and verdict against the other matching ads
  reposts.ts             recognises the same offer re-posted under a new ad ID
  reconcile.ts           pure seed/diff/resync + persist-on-delivery logic
  state.ts               listing history and product price/discount-delivery memory
  notifier.ts            Telegram message formatting (alerts + first-run digest)
  telegram.ts            Telegram Bot API call
state/seen.json          tracking state, committed by the Action
test/                    unit + parser tests (fixtures modelled on live pages)
.github/workflows/       the scheduled cron job
```

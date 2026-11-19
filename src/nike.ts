import { nikeStyleColor, parseNikeProduct } from './parsers/nike';
import type { ProductSnapshot } from './types';

// Nike's public product feed returns a colour's price, sizes and stock in one response, with no
// account or API key. The channel is Nike.com itself (not the SNKRS app or a store).
const FEED = 'https://api.nike.com/product_feed/threads/v2';
const NIKE_COM_CHANNEL = 'd9a5bc42-4b9c-4976-858a-f159cf99c647';

export function createNikeCollector(request: typeof fetch = fetch): (url: string) => Promise<ProductSnapshot> {
  return async (sourceUrl) => {
    const filters = ['marketplace(FR)', 'language(fr)', `channelId(${NIKE_COM_CHANNEL})`,
      `productInfo.merchProduct.styleColor(${nikeStyleColor(sourceUrl)})`];
    const query = new URLSearchParams(filters.map((filter): [string, string] => ['filter', filter]));
    const response = await request(`${FEED}?${query}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Nike product request failed: HTTP ${response.status}`);
    let data: unknown;
    try { data = JSON.parse(await response.text()); }
    catch { throw new Error('Nike: the product feed did not return JSON (a block page?)'); }
    return parseNikeProduct(data, sourceUrl);
  };
}

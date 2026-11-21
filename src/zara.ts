import { parseZaraProduct, zaraColorId } from './parsers/zara';
import type { ProductSnapshot } from './types';

// Zara's site loads each product page's data as JSON (`?ajax=true`): every colour's price and the
// stock of each size. No account or API key is involved.
export function createZaraCollector(request: typeof fetch = fetch): (url: string) => Promise<ProductSnapshot> {
  return async (sourceUrl) => {
    const page = new URL(sourceUrl);
    const query = new URLSearchParams({ v1: String(zaraColorId(sourceUrl)), ajax: 'true' });
    const response = await request(`${page.origin}${page.pathname}?${query}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Zara product request failed: HTTP ${response.status}`);
    let data: unknown;
    try { data = JSON.parse(await response.text()); }
    catch { throw new Error('Zara: the product page did not return JSON (a bot check?)'); }
    return parseZaraProduct(data, sourceUrl);
  };
}

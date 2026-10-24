import { chromium } from 'playwright';

/**
 * Load a page in an isolated browser so its JavaScript challenge can finish. Read the original
 * document response: Dubizzle removes window.state from the DOM after hydration, which would
 * otherwise lose mileage, year and seller IDs. Each fetch closes its browser even on failure.
 */
export async function fetchBrowser(
  url: string,
  validate: (html: string) => void,
  timeoutMs = 70_000,
): Promise<string> {
  const target = new URL(url);
  const browser = await chromium.launch({ channel: 'chromium', timeout: 30_000 });
  try {
    const context = await browser.newContext({
      locale: 'en-US',
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`,
    });
    const page = await context.newPage();
    let lastFailure = 'no valid search document received';
    const ready = page.waitForResponse(async (response) => {
      const request = response.request();
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return false;
      const received = new URL(response.url());
      if (received.origin !== target.origin || received.pathname !== target.pathname ||
          [...target.searchParams].some(([key, value]) => received.searchParams.get(key) !== value)) {
        return false;
      }
      if (!response.ok()) { lastFailure = `HTTP ${response.status()}`; return false; }
      try {
        validate(await response.text());
        return true;
      } catch (error) {
        lastFailure = (error as Error).message;
        return false;
      }
    }, { timeout: timeoutMs });
    try {
      // Challenge scripts can reload or replace the first navigation. The accepted document,
      // rather than the initial response status or a transient navigation error, decides success.
      const [response] = await Promise.all([
        ready,
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => undefined),
      ]);
      return await response.text();
    } catch {
      throw new Error(`Browser could not read ${url}: ${lastFailure}`);
    }
  } finally {
    await browser.close();
  }
}

import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchBrowser } from '../src/browser';
import { parseDubizzle } from '../src/parsers/dubizzle';

const fixture = readFileSync(new URL('./fixtures/dubizzle-leon.html', import.meta.url), 'utf8');
const servers: Server[] = [];

async function serve(challengeOnly = false): Promise<string> {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.headers.cookie?.includes('ready=1') && !challengeOnly) {
      response.end(fixture);
    } else {
      response.statusCode = challengeOnly ? 200 : 503;
      response.end(challengeOnly
        ? '<html><body>dubizzle.com.eg<script>/* challenge did not finish */</script></body></html>'
        : '<html><body><script>document.cookie="ready=1; path=/"; location.reload();</script></body></html>');
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not start');
  return `http://127.0.0.1:${address.port}/search?filter=year_min_2021&page=2`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

// These tests use a real Chromium process and a local server, never the live website. Run after
// `npx playwright install --with-deps --no-shell chromium` with TEST_BROWSER=1.
describe.skipIf(process.env.TEST_BROWSER !== '1')('browser challenge handling', () => {
  it('waits through a 503 challenge reload and preserves original data removed by hydration', async () => {
    const url = await serve();
    const html = await fetchBrowser(url, (content) => { parseDubizzle(content); }, 5000);
    const { listings } = parseDubizzle(html);
    expect(listings).toHaveLength(7);
    expect(listings[0]?.attributes).toMatchObject({ Year: '2026', Kilometers: '14000' });
    expect(html).toContain('window.state =');
    expect(listings.every((listing) => listing.sellerId !== null)).toBe(true);
  }, 20_000);

  it('rejects a challenge-only HTTP 200 instead of recording zero listings', async () => {
    const url = await serve(true);
    await expect(fetchBrowser(url, (content) => { parseDubizzle(content); }, 500))
      .rejects.toThrow(/no listing data/);
  }, 20_000);
});

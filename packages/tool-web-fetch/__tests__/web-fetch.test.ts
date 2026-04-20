import { describe, it, expect, vi, afterEach } from 'vitest';
import { webFetchTool } from '../src/index.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetchHtml(html: string, opts: Partial<{ status: number; contentType: string }> = {}): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(html, {
      status: opts.status ?? 200,
      headers: { 'content-type': opts.contentType ?? 'text/html; charset=utf-8' },
    }),
  ) as unknown as typeof fetch;
}

describe('web_fetch tool — single URL', () => {
  it('has correct metadata', () => {
    expect(webFetchTool.name).toBe('web_fetch');
    expect(webFetchTool.permissionLevel).toBe('auto');
    expect(webFetchTool.parameters.properties).toHaveProperty('url');
    expect(webFetchTool.parameters.properties).toHaveProperty('urls');
  });

  it('strips HTML tags and returns readable text', async () => {
    mockFetchHtml(`
      <html>
        <head><title>Weather</title><style>body{color:red}</style></head>
        <body>
          <script>var x = 1;</script>
          <h1>Погода у Лозовій</h1>
          <p>Завтра: <strong>+18°C</strong>, без опадів.</p>
        </body>
      </html>
    `);

    const res = await webFetchTool.handler({ url: 'https://example.com/weather' });

    expect(res.success).toBe(true);
    if (!res.success) return;
    const data = res.data as { sources: Array<{ text: string }>; total_succeeded: number };
    expect(data.total_succeeded).toBe(1);
    expect(data.sources[0].text).toContain('Погода у Лозовій');
    expect(data.sources[0].text).toContain('+18°C');
    expect(data.sources[0].text).not.toContain('<h1>');
  });

  it('decodes common HTML entities', async () => {
    mockFetchHtml('<html><body><p>Tom &amp; Jerry &lt;3 &nbsp; &#8212; hi</p></body></html>');
    const res = await webFetchTool.handler({ url: 'https://example.com' });
    expect(res.success).toBe(true);
    if (!res.success) return;
    const data = res.data as { sources: Array<{ text: string }> };
    expect(data.sources[0].text).toContain('Tom & Jerry <3');
  });

  it('truncates output when longer than max_chars', async () => {
    const longBody = '<html><body>' + 'A'.repeat(5000) + '</body></html>';
    mockFetchHtml(longBody);

    const res = await webFetchTool.handler({ url: 'https://example.com', max_chars: 200 });
    expect(res.success).toBe(true);
    if (!res.success) return;
    const data = res.data as { sources: Array<{ text: string; truncated: boolean; length: number }> };
    const src = data.sources[0];
    expect(src.truncated).toBe(true);
    expect(src.text.endsWith('...[truncated]')).toBe(true);
    expect(src.length).toBe(5000);
  });

  it('rejects non-http(s) protocols', async () => {
    const res = await webFetchTool.handler({ url: 'file:///etc/passwd' });
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toMatch(/http\(s\)/);
  });

  it('rejects invalid URLs', async () => {
    const res = await webFetchTool.handler({ url: 'not a url' });
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toMatch(/invalid URL/);
  });

  it('returns HTTP error for non-2xx responses', async () => {
    mockFetchHtml('', { status: 404 });
    const res = await webFetchTool.handler({ url: 'https://example.com' });
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toMatch(/HTTP 404/);
  });

  it('handles non-HTML content as-is', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('plain text body', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    ) as unknown as typeof fetch;

    const res = await webFetchTool.handler({ url: 'https://example.com/robots.txt' });
    expect(res.success).toBe(true);
    if (!res.success) return;
    const data = res.data as { sources: Array<{ text: string }> };
    expect(data.sources[0].text).toBe('plain text body');
  });

  it('returns failure when fetch throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const res = await webFetchTool.handler({ url: 'https://example.com' });
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toMatch(/network down/);
  });
});

describe('web_fetch tool — multi-URL (all successful returned)', () => {
  it('returns every successful fetch so the LLM can compare sources', async () => {
    const payloads: Record<string, string> = {
      'https://a.example/w': '<html><body>Source A: +11°C</body></html>',
      'https://b.example/w': '<html><body>Source B: +13°C</body></html>',
      'https://c.example/w': '<html><body>Source C: +12°C</body></html>',
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = payloads[url];
      if (!body) throw new Error(`no mock for ${url}`);
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;

    const res = await webFetchTool.handler({
      urls: Object.keys(payloads),
    });

    expect(res.success).toBe(true);
    if (!res.success) return;
    const data = res.data as {
      sources: Array<{ url: string; text: string }>;
      failures: unknown[];
      total_succeeded: number;
      total_requested: number;
    };
    expect(data.total_requested).toBe(3);
    expect(data.total_succeeded).toBe(3);
    expect(data.failures).toHaveLength(0);
    const joined = data.sources.map((s) => s.text).join(' ');
    expect(joined).toMatch(/\+11°C/);
    expect(joined).toMatch(/\+13°C/);
    expect(joined).toMatch(/\+12°C/);
  });

  it('keeps successful sources even when some URLs fail', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('blocked')) throw new Error('connection timeout');
      if (url.includes('forbidden')) {
        return new Response('', { status: 403 });
      }
      return new Response('<html><body>Real data: +14°C</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof fetch;

    const res = await webFetchTool.handler({
      urls: [
        'https://blocked.example/w',
        'https://working.example/w',
        'https://forbidden.example/w',
      ],
    });

    expect(res.success).toBe(true);
    if (!res.success) return;
    const data = res.data as {
      sources: Array<{ url: string; text: string }>;
      failures: Array<{ url: string; error: string }>;
    };
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0].url).toBe('https://working.example/w');
    expect(data.sources[0].text).toContain('+14°C');
    expect(data.failures).toHaveLength(2);
    expect(data.failures.some((f) => f.error.includes('timeout'))).toBe(true);
    expect(data.failures.some((f) => f.error.includes('403'))).toBe(true);
  });

  it('returns a consolidated failure only when every URL fails', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch;

    const res = await webFetchTool.handler({
      urls: ['https://a.example/x', 'https://b.example/y', 'https://c.example/z'],
    });

    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toMatch(/all 3 URLs failed/);
    expect(res.error).toContain('a.example');
    expect(res.error).toContain('b.example');
    expect(res.error).toContain('c.example');
  });

  it('prepends single `url` as the first candidate when both url and urls are given', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const requested = String(input);
      if (requested.includes('preferred')) {
        return new Response('<html><body>preferred body</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      throw new Error('no body');
    }) as unknown as typeof fetch;

    const res = await webFetchTool.handler({
      url: 'https://preferred.example/page',
      urls: ['https://fallback.example/page'],
    });

    expect(res.success).toBe(true);
    if (!res.success) return;
    const data = res.data as { sources: Array<{ url: string }> };
    // The preferred URL should always appear; fallback is a separate failure.
    expect(data.sources.some((s) => s.url === 'https://preferred.example/page')).toBe(true);
  });

  it('caps the number of URLs at MAX_URLS_PER_CALL', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error('down');
    }) as unknown as typeof fetch;

    const urls = Array.from({ length: 20 }, (_, i) => `https://site${i}.example/`);
    await webFetchTool.handler({ urls });

    expect(calls.length).toBeLessThanOrEqual(8);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('deduplicates URLs while preserving order', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error('down');
    }) as unknown as typeof fetch;

    await webFetchTool.handler({
      urls: ['https://a.example/', 'https://b.example/', 'https://a.example/'],
    });

    expect(new Set(calls).size).toBe(2);
    expect(calls.filter((u) => u === 'https://a.example/').length).toBe(1);
  });

  it('requires url or urls (error when neither provided)', async () => {
    const res = await webFetchTool.handler({});
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toMatch(/required/);
  });
});

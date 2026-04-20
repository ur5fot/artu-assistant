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

describe('web_fetch tool', () => {
  it('has correct metadata', () => {
    expect(webFetchTool.name).toBe('web_fetch');
    expect(webFetchTool.permissionLevel).toBe('auto');
    expect(webFetchTool.parameters.required).toContain('url');
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
    const data = res.data as { text: string; truncated: boolean; length: number };
    expect(data.text).toContain('Погода у Лозовій');
    expect(data.text).toContain('+18°C');
    expect(data.text).toContain('без опадів');
    expect(data.text).not.toContain('<h1>');
    expect(data.text).not.toContain('var x = 1');
    expect(data.text).not.toContain('color:red');
    expect(data.truncated).toBe(false);
  });

  it('decodes common HTML entities', async () => {
    mockFetchHtml('<html><body><p>Tom &amp; Jerry &lt;3 &nbsp; &#8212; hi</p></body></html>');
    const res = await webFetchTool.handler({ url: 'https://example.com' });
    expect(res.success).toBe(true);
    if (!res.success) return;
    const data = res.data as { text: string };
    expect(data.text).toContain('Tom & Jerry <3');
  });

  it('truncates output when longer than max_chars', async () => {
    const longBody = '<html><body>' + 'A'.repeat(5000) + '</body></html>';
    mockFetchHtml(longBody);

    const res = await webFetchTool.handler({ url: 'https://example.com', max_chars: 200 });
    expect(res.success).toBe(true);
    if (!res.success) return;
    const data = res.data as { text: string; truncated: boolean; length: number };
    expect(data.truncated).toBe(true);
    expect(data.text.endsWith('...[truncated]')).toBe(true);
    expect(data.length).toBe(5000);
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
    const data = res.data as { text: string };
    expect(data.text).toBe('plain text body');
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

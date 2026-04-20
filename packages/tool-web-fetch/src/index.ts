import type { ToolResult } from '@r2/shared';

const DEFAULT_MAX_CHARS = 10_000;
const HARD_MAX_CHARS = 50_000;
const FETCH_TIMEOUT_MS = 15_000;

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim();
}

export const webFetchTool = {
  name: 'web_fetch',
  description:
    'Fetch a URL and return its readable text (HTML stripped). Use AFTER web_search when the result snippet is not enough and you need the actual page content (weather numbers, article text, prices, etc.). Pass the url from a web_search result.',
  permissionLevel: 'auto' as const,
  provider: 'all' as const,
  command: {
    name: 'fetch',
    description: 'Завантажити сторінку за URL',
    params: [{ name: 'url', required: true, description: 'URL сторінки' }],
  },
  parameters: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: 'The http(s) URL to fetch',
      },
      max_chars: {
        type: 'number',
        description: `Max chars of extracted text to return (default ${DEFAULT_MAX_CHARS}, hard cap ${HARD_MAX_CHARS})`,
      },
    },
    required: ['url'] as string[],
  },

  async handler(params: Record<string, unknown>): Promise<ToolResult> {
    const url = params.url;
    if (typeof url !== 'string' || !url) {
      return { success: false, error: 'web_fetch: url is required' };
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { success: false, error: `web_fetch: invalid URL "${url}"` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, error: `web_fetch: only http(s) is allowed, got ${parsed.protocol}` };
    }

    const rawMax = Number(params.max_chars);
    const maxChars = Math.min(
      Math.max(Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : DEFAULT_MAX_CHARS, 100),
      HARD_MAX_CHARS,
    );

    let response: Response;
    try {
      response = await fetch(parsed.toString(), {
        headers: {
          // Some sites (SINOPTIK, METEO) serve different content or block
          // requests without a browser-like UA. Match a recent Chrome so we
          // get the normal HTML body, not a bot-challenge page.
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'uk,ru;q=0.9,en;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `web_fetch: request failed — ${msg}` };
    }

    if (!response.ok) {
      return { success: false, error: `web_fetch: HTTP ${response.status} ${response.statusText}` };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();

    const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType) || /<html[\s>]/i.test(body);
    const extracted = isHtml ? stripHtml(body) : body.trim();

    const truncated = extracted.length > maxChars;
    const text = truncated ? extracted.slice(0, maxChars) + '\n\n...[truncated]' : extracted;

    return {
      success: true,
      data: {
        url: parsed.toString(),
        final_url: response.url,
        content_type: contentType,
        length: extracted.length,
        truncated,
        text,
      },
      display: {
        type: 'text',
        content: `web_fetch ${parsed.toString()} (${extracted.length} chars${truncated ? ', truncated' : ''})\n\n${text}`,
      },
    };
  },
};

export default webFetchTool;

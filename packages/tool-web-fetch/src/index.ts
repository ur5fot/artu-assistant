import type { ToolResult } from '@r2/shared';

const DEFAULT_SINGLE_MAX_CHARS = 10_000;
const DEFAULT_MULTI_MAX_CHARS = 4_000;
const HARD_MAX_CHARS = 50_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_URLS_PER_CALL = 8;

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

interface FetchOneResult {
  ok: true;
  url: string;
  finalUrl: string;
  contentType: string;
  extracted: string;
}
interface FetchOneFailure {
  ok: false;
  url: string;
  error: string;
}

async function fetchOne(rawUrl: string): Promise<FetchOneResult | FetchOneFailure> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, url: rawUrl, error: `invalid URL` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, url: rawUrl, error: `only http(s) allowed (${parsed.protocol})` };
  }

  let response: Response;
  try {
    response = await fetch(parsed.toString(), {
      headers: {
        // Browser-like UA so weather/news sites serve real HTML instead of
        // a bot-challenge page.
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
    return { ok: false, url: rawUrl, error: `request failed — ${msg}` };
  }

  if (!response.ok) {
    return { ok: false, url: rawUrl, error: `HTTP ${response.status} ${response.statusText}` };
  }

  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType) || /<html[\s>]/i.test(body);
  const extracted = isHtml ? stripHtml(body) : body.trim();

  return {
    ok: true,
    url: parsed.toString(),
    finalUrl: response.url,
    contentType,
    extracted,
  };
}

function normalizeUrls(params: Record<string, unknown>): { list: string[]; error?: string } {
  const urls = params.urls;
  const url = params.url;
  const collected: string[] = [];

  if (Array.isArray(urls)) {
    for (const u of urls) {
      if (typeof u === 'string' && u.trim().length > 0) collected.push(u.trim());
    }
  }
  if (typeof url === 'string' && url.trim().length > 0) {
    collected.unshift(url.trim());
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const u of collected) {
    if (!seen.has(u)) {
      seen.add(u);
      deduped.push(u);
    }
  }

  if (deduped.length === 0) {
    return { list: [], error: 'web_fetch: url or urls is required' };
  }
  if (deduped.length > MAX_URLS_PER_CALL) {
    return { list: deduped.slice(0, MAX_URLS_PER_CALL) };
  }
  return { list: deduped };
}

export const webFetchTool = {
  name: 'web_fetch',
  description:
    'Fetch one or more URLs and return their readable text (HTML stripped). Use AFTER web_search to compare real page content from multiple sources. PREFER passing ALL web_search result URLs via `urls` (up to 8) — the tool fetches them in parallel and returns every successful page, so you can cross-check facts (e.g. compare weather numbers from Sinoptik vs Meteoprog vs Yr) and decide which source is most trustworthy. Use single `url` only when you already know the one page you need.',
  permissionLevel: 'auto' as const,
  provider: 'all' as const,
  command: {
    name: 'fetch',
    description: 'Завантажити сторінку(и) за URL',
    params: [{ name: 'url', required: true, description: 'URL сторінки' }],
  },
  parameters: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description:
          'A single http(s) URL to fetch. Provide either `url` or `urls`. If both are given, `url` is prepended to the list.',
      },
      urls: {
        type: 'array',
        items: { type: 'string' },
        description: `Ordered list of http(s) URLs fetched in parallel. Every successful fetch is returned so you can compare sources. Up to ${MAX_URLS_PER_CALL} URLs per call.`,
      },
      max_chars: {
        type: 'number',
        description: `Max chars of extracted text per page (default ${DEFAULT_MULTI_MAX_CHARS} when multi-URL, ${DEFAULT_SINGLE_MAX_CHARS} when single-URL, hard cap ${HARD_MAX_CHARS}).`,
      },
    },
  },

  async handler(params: Record<string, unknown>): Promise<ToolResult> {
    const { list, error } = normalizeUrls(params);
    if (error) return { success: false, error };

    const isMulti = list.length > 1;
    const defaultMax = isMulti ? DEFAULT_MULTI_MAX_CHARS : DEFAULT_SINGLE_MAX_CHARS;
    const rawMax = Number(params.max_chars);
    const maxChars = Math.min(
      Math.max(Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : defaultMax, 100),
      HARD_MAX_CHARS,
    );

    // Parallel — the whole point is comparing several sources as fast as
    // one round-trip. Each fetchOne has its own AbortSignal.timeout so a
    // single slow site can't stall the rest.
    const settled = await Promise.all(list.map(fetchOne));

    const sources: Array<{
      url: string;
      final_url: string;
      length: number;
      truncated: boolean;
      text: string;
    }> = [];
    const failures: Array<{ url: string; error: string }> = [];

    for (const r of settled) {
      if (!r.ok) {
        failures.push({ url: r.url, error: r.error });
        continue;
      }
      const truncated = r.extracted.length > maxChars;
      sources.push({
        url: r.url,
        final_url: r.finalUrl,
        length: r.extracted.length,
        truncated,
        text: truncated ? r.extracted.slice(0, maxChars) + '\n\n...[truncated]' : r.extracted,
      });
    }

    if (sources.length === 0) {
      return {
        success: false,
        error: `web_fetch: all ${list.length} URL${list.length === 1 ? '' : 's'} failed — ${failures
          .map((a) => `${a.url} (${a.error})`)
          .join('; ')}`,
      };
    }

    const displayHeader = `web_fetch: ${sources.length}/${list.length} source${list.length === 1 ? '' : 's'} succeeded` +
      (failures.length > 0 ? ` (failed: ${failures.map((f) => `${f.url} — ${f.error}`).join('; ')})` : '');
    const displayBody = sources
      .map((s, i) => `--- SOURCE ${i + 1}: ${s.url} (${s.length} chars${s.truncated ? ', truncated' : ''}) ---\n${s.text}`)
      .join('\n\n');

    return {
      success: true,
      data: {
        sources,
        failures,
        total_requested: list.length,
        total_succeeded: sources.length,
      },
      display: {
        type: 'text',
        content: `${displayHeader}\n\n${displayBody}`,
      },
    };
  },
};

export default webFetchTool;

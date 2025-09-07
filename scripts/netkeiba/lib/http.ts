import { setTimeout as sleepTimer } from 'node:timers/promises';
import iconv from 'iconv-lite';

export type FetchOptions = {
  headers?: Record<string, string>;
  retry?: number; // default 3
  minIntervalMs?: number; // default 500
};

export async function sleep(ms: number) {
  await sleepTimer(ms);
}

export function userAgent(): string {
  return (
    process.env.SCRAPER_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
  );
}

function decodeBody(buf: Uint8Array, contentType?: string | null): string {
  const ct = (contentType || '').toLowerCase();
  const m = ct.match(/charset=([^;]+)/);
  const charset = m ? m[1].trim() : undefined;
  if (!charset || charset.includes('utf-8')) return new TextDecoder('utf-8').decode(buf);
  // shift_jis 等
  return iconv.decode(Buffer.from(buf), charset as any);
}

export async function fetchHtml(url: string, opts: FetchOptions = {}): Promise<string> {
  const retry = opts.retry ?? 3;
  const minInterval = opts.minIntervalMs ?? Number(process.env.SCRAPER_INTERVAL_MS || 3000);
  let lastError: unknown;
  for (let i = 0; i < retry; i++) {
    try {
      await sleep(minInterval);
      const res = await fetch(url, {
        headers: { 'user-agent': userAgent(), ...(opts.headers || {}) }
      } as any);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const html = decodeBody(buf, res.headers.get('content-type'));
      return html;
    } catch (e) {
      lastError = e;
      if (i === retry - 1) break;
    }
  }
  throw lastError;
}

export function toAbsoluteUrl(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

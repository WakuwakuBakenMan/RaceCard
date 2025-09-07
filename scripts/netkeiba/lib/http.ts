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

function sniffCharset(buf: Uint8Array, contentType?: string | null): string | undefined {
  const ct = (contentType || '').toLowerCase();
  const m = ct.match(/charset=([^;]+)/);
  if (m) return m[1].trim();
  // HTML内の<meta> から推定
  const head = Buffer.from(buf.slice(0, 2048)).toString('ascii');
  const m2 = head.match(/charset=([a-zA-Z0-9_-]+)/i);
  return m2 ? m2[1].trim() : undefined;
}

function decodeBody(buf: Uint8Array, contentType?: string | null): string {
  const charsetRaw = sniffCharset(buf, contentType)?.toLowerCase();
  const candidates = [
    charsetRaw,
    'utf-8',
    'shift_jis',
    'euc-jp',
    'iso-2022-jp'
  ].filter(Boolean) as string[];

  const normalized = (enc: string): string => {
    const e = enc.toLowerCase();
    if (e.includes('utf')) return 'utf-8';
    if (e.includes('shift') || e === 'sjis' || e.includes('s_jis')) return 'Shift_JIS';
    if (e.includes('euc')) return 'EUC-JP';
    if (e.includes('2022')) return 'ISO-2022-JP';
    return enc;
  };

  const decodeWith = (enc: string): string => {
    const n = normalized(enc);
    if (n === 'utf-8') return new TextDecoder('utf-8').decode(buf);
    return iconv.decode(Buffer.from(buf), n as any);
  };

  const hasJapanese = (s: string) => /[\u3040-\u30ff\u3400-\u9fff]/.test(s);

  for (const enc of candidates) {
    try {
      const text = decodeWith(enc);
      if (hasJapanese(text)) return text;
  } catch {
    // ignore
  }
  }
  // 最後のフォールバック
  return new TextDecoder('utf-8').decode(buf);
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

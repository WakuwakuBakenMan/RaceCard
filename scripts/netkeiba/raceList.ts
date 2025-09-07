import { chromium } from 'playwright';
// toAbsoluteUrl はブラウザ内でURL解決するため未使用

export type RaceLink = { no: number; name?: string; url: string; race_id?: string };
export type Meeting = { title: string; kaiji: number; track: string; nichiji: number; races: RaceLink[] };
export type RaceDayList = { date: string; meetings: Meeting[] };

const LIST_URL = (d: string) => `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${d}`;

const TITLE_RE = /(\d+)\s*回\s*([^\s]+)\s*(\d+)\s*日目/;

export async function getRaceList(yyyymmdd: string): Promise<RaceDayList> {
  const url = LIST_URL(yyyymmdd);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const TITLE_SRC = TITLE_RE.source;
  const data = await page.evaluate((TITLE_SRC) => {
    const TITLE_RE = new RegExp(TITLE_SRC);
    const all = Array.from(document.querySelectorAll('body *'));
    const titleIdxs: number[] = [];
    for (let i = 0; i < all.length; i++) {
      const txt = (all[i].textContent || '').trim();
      if (TITLE_RE.test(txt)) titleIdxs.push(i);
    }
    const meetingMap = new Map<string, any>();
    const parseRaceNo = (text: string, href: string) => {
      const m = text.match(/(\d+)\s*R/);
      if (m) return Number(m[1]);
      const m2 = href.match(/race_id=(\d{10})(\d{2})/);
      if (m2) return Number(m2[2]);
      return 0;
    };
    const toAbs = (href: string) => new URL(href, location.href).toString();
    const pushRange = (start: number, end: number) => {
      const titleEl = all[start];
      const titleText = (titleEl.textContent || '').trim();
      const m = titleText.match(TITLE_RE);
      if (!m) return;
      const kaiji = Number(m[1]);
      const track = m[2];
      const nichiji = Number(m[3]);
      const slice = all.slice(start + 1, end);
      const anchors: HTMLAnchorElement[] = [];
      for (const e of slice) {
        if ((e as HTMLElement).tagName?.toLowerCase() === 'a') anchors.push(e as HTMLAnchorElement);
        anchors.push(...Array.from(e.querySelectorAll('a')));
      }
      const seen = new Set<string>();
      const races: any[] = [];
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const text = (a.textContent || '').trim();
        const mId = href.match(/race_id=(\d{12})/);
        if (!mId) continue;
        const abs = toAbs(href);
        if (seen.has(mId[1])) continue;
        const no = parseRaceNo(text, href);
        races.push({ no, name: text || undefined, url: abs, race_id: mId[1] });
        seen.add(mId[1]);
      }
      const key = `${kaiji}|${track}|${nichiji}`;
      const title = `${kaiji}回 ${track} ${nichiji}日目`;
      if (!meetingMap.has(key)) meetingMap.set(key, { title, kaiji, track, nichiji, races: [] });
      const existing = meetingMap.get(key);
      const seen2 = new Set(existing.races.map((r: any) => r.race_id || r.url));
      for (const r of races) if (!seen2.has(r.race_id || r.url)) existing.races.push(r);
      existing.races.sort((a: any, b: any) => a.no - b.no);
    };
    for (let i = 0; i < titleIdxs.length; i++) {
      const start = titleIdxs[i];
      const end = i + 1 < titleIdxs.length ? titleIdxs[i + 1] : all.length;
      pushRange(start, end);
    }
    return { meetings: Array.from(meetingMap.values()) };
  }, TITLE_SRC);
  await browser.close();
  return { date: yyyymmdd, meetings: (data.meetings as any) as Meeting[] };
}

// parseRaceNo はブラウザ評価側に実装

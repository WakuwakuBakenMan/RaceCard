import { chromium } from 'playwright';

type HorseRow = { name: string; id: string };

function z2h(s: string): string {
  return s.replace(/[０-９．]/g, (c) => ({
    '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9', '．': '.'
  }[c] || c));
}

async function getShutubaHorses(page: import('playwright').Page, raceId: string): Promise<HorseRow[]> {
  const url = `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tr.HorseList');
  const data = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr.HorseList')) as HTMLTableRowElement[];
    return rows.map((tr) => {
      const info = tr.querySelector('td.HorseInfo');
      const name = (info?.querySelector('.HorseName')?.textContent || info?.textContent || '').trim();
      const href = info?.querySelector('a[href*="/horse/"]')?.getAttribute('href') || '';
      const m = href.match(/horse\/(\d+)/);
      const id = m ? m[1] : '';
      return { name, id };
    });
  });
  return data.filter((h) => h.name && h.id);
}

async function getHorsePassagesBefore(page: import('playwright').Page, horseId: string, yyyymmdd: string): Promise<string[]> {
  const url = `https://db.netkeiba.com/horse/${horseId}`;
  await page.goto(url, { waitUntil: 'networkidle' });
  // 成績タブがあればクリック
  try {
    const tab = page.locator('text=成績').first();
    if (await tab.count()) {
      await tab.click({ timeout: 1000 });
      await page.waitForTimeout(300);
    }
  } catch {}
  await page.waitForSelector('table', { timeout: 3000 }).catch(() => {});

  const passages = await page.evaluate((dateStr) => {
    function parseDate(s: string): number | null {
      const m = s.match(/(\d{4})\/(\d{2})\/(\d{2})/);
      if (!m) return null;
      return Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
    }
    const isPassage = (s: string) => /\d+(-\d+)+/.test(s);
    const target = Date.parse(`${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}T00:00:00`);
    const tables = Array.from(document.querySelectorAll('table')) as HTMLTableElement[];
    for (const tbl of tables) {
      const headers = Array.from(tbl.querySelectorAll('thead th')).map((th) => (th.textContent || '').trim());
      let idxDate = headers.findIndex((h) => h.includes('日付'));
      let idxPass = headers.findIndex((h) => h.includes('通過'));
      const rows = Array.from(tbl.querySelectorAll('tbody tr')) as HTMLTableRowElement[];
      if (idxPass === -1 && rows.length) {
        const cols = Array.from(rows[0].querySelectorAll('td')).length;
        for (let c = 0; c < cols; c++) {
          const cell = (rows[0].querySelectorAll('td')[c] as HTMLTableCellElement)?.textContent || '';
          if (isPassage(cell.trim())) { idxPass = c; break; }
        }
      }
      if (idxDate === -1 && rows.length) {
        const cols = Array.from(rows[0].querySelectorAll('td')).length;
        for (let c = 0; c < cols; c++) {
          const cell = (rows[0].querySelectorAll('td')[c] as HTMLTableCellElement)?.textContent || '';
          if (/\d{4}\/\d{2}\/\d{2}/.test(cell.trim())) { idxDate = c; break; }
        }
      }
      if (idxPass === -1 || idxDate === -1) continue;
      const out: string[] = [];
      for (const tr of rows) {
        const tds = Array.from(tr.querySelectorAll('td')) as HTMLTableCellElement[];
        const dts = parseDate((tds[idxDate]?.textContent || '').trim());
        if (dts == null) continue;
        if (dts >= target) continue;
        const pass = (tds[idxPass]?.textContent || '').trim();
        if (isPassage(pass)) out.push(pass);
        if (out.length >= 3) break;
      }
      if (out.length) return out;
    }
    return [] as string[];
  }, yyyymmdd);
  return passages as string[];
}

function classifyTypes(passages: string[]): ('A'|'B'|'C')[] {
  let all4 = 0; let nige = 0;
  for (const p of passages) {
    const parts = p.split('-').map((s) => parseInt(z2h(s), 10)).filter((n) => Number.isFinite(n));
    if (!parts.length) continue;
    if (Math.max(...parts) <= 4) all4 += 1;
    if (parts[0] === 1) nige += 1;
  }
  const t: ('A'|'B'|'C')[] = [];
  if (nige >= 2) t.push('A');
  if (all4 >= 2) t.push('B');
  else if (all4 === 1) t.push('C');
  return t;
}

function computePaceScore(allTypes: ('A'|'B'|'C')[][]): number {
  let plcOnCnt = 0;
  let target2Count = 0; // B
  let nigeUma = 0; // A
  for (const t of allTypes) {
    if (t.includes('B')) { plcOnCnt += 1.0; target2Count += 1; }
    else if (t.includes('C')) { plcOnCnt += 0.5; }
    if (t.includes('A')) nigeUma += 1;
  }
  if (nigeUma === 0) plcOnCnt -= 1.5; else if (nigeUma >= 2) plcOnCnt += 1.5;
  if (target2Count <= 2) plcOnCnt -= 1.0;
  return plcOnCnt;
}

async function main() {
  const args = process.argv.slice(2);
  // 例: --date 20250906 --track 札幌 --no 8
  const dateIdx = args.indexOf('--date');
  const trackIdx = args.indexOf('--track');
  const noIdx = args.indexOf('--no');
  if (dateIdx === -1 || trackIdx === -1 || noIdx === -1) {
    console.error('Usage: tsx scripts/netkeiba/debug-bias.ts --date YYYYMMDD --track 場 --no R');
    process.exit(1);
  }
  const ymd = args[dateIdx + 1];
  const track = args[trackIdx + 1];
  const no = Number(args[noIdx + 1]);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage();

  // race_id を race_list_sub から解決
  const listUrl = `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${ymd}`;
  await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
  const raceId = await page.evaluate((t, rno) => {
    const titleRe = new RegExp('(\\d+)\\s*回\\s*' + t + '\\s*(\\d+)\\s*日目');
    const all = Array.from(document.querySelectorAll('body *'));
    const titles: number[] = [];
    for (let i = 0; i < all.length; i++) {
      const txt = (all[i].textContent || '').trim();
      if (titleRe.test(txt)) titles.push(i);
    }
    if (!titles.length) return '';
    const start = titles[0];
    const end = (titles[1] ?? all.length);
    const slice = all.slice(start + 1, end);
    const anchors: HTMLAnchorElement[] = [];
    for (const e of slice) {
      if ((e as HTMLElement).tagName?.toLowerCase() === 'a') anchors.push(e as HTMLAnchorElement);
      anchors.push(...Array.from(e.querySelectorAll('a')));
    }
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const txt = (a.textContent || '').trim();
      const mId = href.match(/race_id=(\d{12})/);
      if (!mId) continue;
      const mNo = txt.match(/(\d+)\s*R/);
      const noVal = mNo ? Number(mNo[1]) : (mId[1].slice(-2) as any) * 1;
      if (noVal === rno) return mId[1];
    }
    return '';
  }, track, no);

  if (!raceId) {
    console.error('race_id not found for', ymd, track, no);
    await browser.close();
    process.exit(1);
  }

  const horses = await getShutubaHorses(page, raceId);
  const allPassages: { name: string; id: string; passages: string[] }[] = [];
  for (const h of horses) {
    const passages = await getHorsePassagesBefore(page, h.id, ymd);
    allPassages.push({ name: h.name, id: h.id, passages });
    await page.waitForTimeout( Number(process.env.SCRAPER_INTERVAL_MS || 3000) );
  }

  const allTypes = allPassages.map((hp) => classifyTypes(hp.passages));
  const score = computePaceScore(allTypes);

  const A = allPassages.filter((_, i) => allTypes[i].includes('A')).map((x) => x.name);
  const B = allPassages.filter((_, i) => allTypes[i].includes('B')).map((x) => x.name);
  const C = allPassages.filter((_, i) => allTypes[i].includes('C') && !allTypes[i].includes('B')).map((x) => x.name);

  console.log(`対象: ${track} ${no}R ${ymd} / race_id=${raceId}`);
  console.log(`展開カウント: ${score}`);
  console.log('▼近３走中２回以上全角４以内馬');
  console.log(B.join('\n'));
  console.log('◆近３走中１回全角４以内馬');
  console.log(C.join('\n'));
  console.log('★近３走中２走逃げ馬');
  console.log(A.join('\n'));

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });


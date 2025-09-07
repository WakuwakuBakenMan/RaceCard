/*
  netkeiba から出馬表 + 展開バイアス（簡易）を収集し、
  RaceDay JSON を生成して public/data/date{1..4}.json に反映します。

  注意:
  - 本スクリプトは学習・検証用のサンプルです。対象サイトの利用規約に従ってください。
  - 実行にはネットワークアクセスとヘッドレスブラウザが必要です。
  - DOM 構造の変更でパースが壊れる場合があります。必要に応じてセレクタを調整してください。
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

type Horse = {
  num: number;
  draw: number;
  name: string;
  sex: string;
  age: number;
  weight: number;
  jockey: string;
  trainer: string;
  odds?: number;
  popularity?: number;
  pace_type?: Array<'A' | 'B' | 'C'>;
};
type Race = {
  no: number;
  name: string;
  distance_m: number;
  ground: string;
  course_note?: string;
  condition?: string;
  start_time?: string;
  pace_score?: number;
  pace_mark?: string;
  horses: Horse[];
};
type Meeting = {
  track: string;
  kaiji: number;
  nichiji: number;
  races: Race[];
};
type RaceDay = {
  date: string; // YYYY-MM-DD
  meetings: Meeting[];
};

const courseDict: Record<string, string> = {
  '01': '札幌',
  '02': '函館',
  '03': '福島',
  '04': '新潟',
  '05': '東京',
  '06': '中山',
  '07': '中京',
  '08': '京都',
  '09': '阪神',
  '10': '小倉'
};

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p: string, data: unknown) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out: { date?: string; from?: string; to?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--date') out.date = args[++i];
    else if (a === '--from') out.from = args[++i];
    else if (a === '--to') out.to = args[++i];
  }
  return out;
}

function ymdToDash(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

async function getRaceIdsForDate(page: puppeteer.Page, yyyymmdd: string): Promise<string[]> {
  const url = `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${yyyymmdd}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const ids = await page.$$eval('a[href]', (as) => {
    const out = new Set<string>();
    for (const a of as as HTMLAnchorElement[]) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/(\d{12})/);
      if (m) out.add(m[1]);
    }
    return Array.from(out).sort();
  });
  return ids;
}

async function getRaceCard(page: puppeteer.Page, raceId: string): Promise<{ race: Omit<Race, 'horses'>; horses: Horse[]; track: string; kaiji: number; nichiji: number } | null> {
  const url = `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body');

  // トラック名は raceId から推定（04=新潟 など）。
  const courseCode = raceId.slice(4, 6);
  const track = courseDict[courseCode] || '不明';
  // kaiji/nichiji は raceId からの推定が困難なため 0 をセット（必要なら強化）
  const kaiji = 0;
  const nichiji = 0;

  const data = await page.evaluate(() => {
    const getText = (sel: string) => document.querySelector(sel)?.textContent?.trim() || '';
    const raceName = getText('h1.RaceName');
    const data01 = document.querySelector('div.RaceData01 span')?.textContent?.trim() || '';
    // 例: "芝1600m" / "ダート1800m"
    const distance_m = Number((data01.match(/(\d+)m/) || [])[1] || 0);
    const ground = data01.replace(/\d+m.*/, '').trim();
    const condition = (document.querySelectorAll('div.RaceData01 span')?.[1] as HTMLElement)?.textContent?.trim() || '';
    const start_time = (document.querySelector('div.RaceData02')?.textContent || '').match(/発走\s*(\d{1,2}:\d{2})/)?.[1] || '';

    const rows = Array.from(document.querySelectorAll('tr.HorseList')) as HTMLTableRowElement[];
    const horses = rows.map((tr, idx) => {
      const td = (sel: string) => tr.querySelector(sel) as HTMLElement | null;
      // 枠・馬番はクラス名が変わる可能性があるためフォールバックを多段に
      const drawTxt = td('td.Waku')?.textContent?.trim() || td('td:nth-child(1)')?.textContent?.trim() || '';
      const numTxt = td('td.Umaban')?.textContent?.trim() || td('td:nth-child(2)')?.textContent?.trim() || '';
      const infoTd = td('td.HorseInfo');
      const name = infoTd?.querySelector('.HorseName')?.textContent?.trim() || infoTd?.textContent?.trim() || `馬${idx + 1}`;
      // 騎手/斤量はページDOMに依存するため取れない場合は空
      const jockey = tr.querySelector('td.Jockey a')?.textContent?.trim() || '';
      const weightTxt = tr.querySelector('td.Weight')?.textContent?.trim() || '';
      const trainer = tr.querySelector('td.Trainer a')?.textContent?.trim() || '';
      const sexAge = tr.querySelector('td.Age')?.textContent?.trim() || '';

      const sex = sexAge.slice(0, 1) || '';
      const age = Number(sexAge.slice(1) || 0);
      const weight = Number((weightTxt.match(/\d+(?:\.\d+)?/) || [])[0] || 0);
      return {
        num: Number(numTxt || idx + 1),
        draw: Number(drawTxt || 0),
        name,
        sex,
        age: Number.isFinite(age) ? age : 0,
        weight: Number.isFinite(weight) ? weight : 0,
        jockey,
        trainer
      } as Horse;
    });

    return {
      raceName,
      distance_m,
      ground,
      condition,
      start_time,
      horses
    };
  });

  if (!data) return null;
  const race: Omit<Race, 'horses'> = {
    no: Number(raceId.slice(-2)),
    name: data.raceName || '未定',
    distance_m: data.distance_m,
    ground: data.ground || '',
    condition: data.condition || undefined,
    start_time: data.start_time || undefined
  };
  return { race, horses: data.horses, track, kaiji, nichiji };
}

async function getHorsePassagesBefore(page: puppeteer.Page, horseId: string, yyyymmdd: string): Promise<string[]> {
  const url = `https://db.netkeiba.com/horse/${horseId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const targetDate = new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T00:00:00`);
  // テーブル内でヘッダに「通過」が含まれる行を探し、直近3戦の通過順（レース当日より前）を抜き出す
  const passages: string[] = await page.evaluate((isoDate) => {
    function parseDate(s: string): Date | null {
      // 想定: YYYY/MM/DD
      const m = s.match(/(\d{4})\/(\d{2})\/(\d{2})/);
      if (!m) return null;
      return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
    }
    const tables = Array.from(document.querySelectorAll('table')) as HTMLTableElement[];
    for (const tbl of tables) {
      const headers = Array.from(tbl.querySelectorAll('thead th')).map((th) => th.textContent?.trim());
      const idxPass = headers.findIndex((h) => (h || '').includes('通過'));
      const idxDate = headers.findIndex((h) => (h || '').includes('日付'));
      if (idxPass === -1 || idxDate === -1) continue;
      const rows = Array.from(tbl.querySelectorAll('tbody tr')) as HTMLTableRowElement[];
      const out: string[] = [];
      for (const tr of rows) {
        const tds = Array.from(tr.querySelectorAll('td')) as HTMLTableCellElement[];
        const dateText = tds[idxDate]?.textContent?.trim() || '';
        const dtObj = parseDate(dateText);
        if (!dtObj) continue;
        if (dtObj.getTime() >= Date.parse(isoDate)) continue; // 当日以降は除外
        const pass = tds[idxPass]?.textContent?.trim() || '';
        out.push(pass);
        if (out.length >= 3) break;
      }
      return out;
    }
    return [];
  }, targetDate.toISOString());
  return passages;
}

function computePaceBias(passagesList: string[]): { score: number; mark?: string } {
  // Pythonサンプルのロジックを踏襲
  let all4cnt = 0; // 全コーナー4番手以内の回数（最大3）
  let nigecnt = 0; // 逃げ回数（先頭:1）
  for (const passages of passagesList) {
    if (!passages) continue;
    const parts = passages.split('-').map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
    if (parts.length === 0) continue;
    if (Math.max(...parts) <= 4) all4cnt += 1;
    if (parts[0] === 1) nigecnt += 1;
  }
  let score = 0;
  if (all4cnt >= 2) score += 1.0;
  else if (all4cnt === 1) score += 0.5;
  if (nigecnt >= 2) score += 1.5;
  else if (nigecnt === 0) score -= 1.5;
  // 先行馬（all4>=2）が少ない場合の調整
  if (all4cnt <= 2) score -= 1.0;
  // マークの付与は呼び出し側で距離に応じて判断
  return { score };
}

async function main() {
  const args = parseArgs();
  const dates: string[] = [];
  if (args.date) dates.push(args.date);
  else if (args.from && args.to) {
    let cur = args.from;
    while (cur <= args.to) {
      dates.push(cur);
      const d = new Date(`${cur.slice(0, 4)}-${cur.slice(4, 6)}-${cur.slice(6, 8)}T00:00:00`);
      d.setDate(d.getDate() + 1);
      cur = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    }
  } else {
    console.error('Usage: npm run data:scrape -- --date YYYYMMDD | --from YYYYMMDD --to YYYYMMDD');
    process.exit(1);
  }

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  const outDays: RaceDay[] = [];

  for (const ymd of dates) {
    console.log(`Scraping date ${ymd} ...`);
    const raceIds = await getRaceIdsForDate(page, ymd);
    if (raceIds.length === 0) continue;

    // Meeting 単位にまとめる
    const meetingsMap = new Map<string, Meeting>();
    for (const rid of raceIds) {
      const card = await getRaceCard(page, rid);
      if (!card) continue;
      const meetingKey = `${card.track}:${card.kaiji}:${card.nichiji}`;
      if (!meetingsMap.has(meetingKey)) {
        meetingsMap.set(meetingKey, { track: card.track, kaiji: card.kaiji, nichiji: card.nichiji, races: [] });
      }
      // 展開バイアス算出
      // 馬IDは shutuba の HorseInfo の href から数字抽出が必要だが、ここではページ評価で取っていないため再取得
      const horsesWithIds = await page.$$eval('tr.HorseList', (rows) =>
        rows.map((tr) => {
          const infoTd = tr.querySelector('td.HorseInfo');
          const a = infoTd?.querySelector('a[href*="/horse/"]') as HTMLAnchorElement | null;
          const href = a?.getAttribute('href') || '';
          const m = href.match(/horse\/(\d+)/);
          const horseId = m ? m[1] : '';
          return horseId;
        })
      );

      // 近走通過データを集計
      let target2Count = 0; // 近3走中2回以上全角4以内
      let nigeCount = 0; // 近3走中2回以上逃げ
      let all4Summed = 0; // 近3走全角4以内回数合計
      for (const hid of horsesWithIds.filter(Boolean)) {
        const passages = await getHorsePassagesBefore(page, hid, ymd);
        // Pythonロジックに近い集計
        let horseAll4 = 0;
        let horseNige = 0;
        for (const p of passages) {
          const parts = p
            .split('-')
            .map((s) => parseInt(s, 10))
            .filter((n) => Number.isFinite(n));
          if (parts.length === 0) continue;
          if (Math.max(...parts) <= 4) horseAll4 += 1;
          if (parts[0] === 1) horseNige += 1;
        }
        all4Summed += horseAll4;
        if (horseAll4 >= 2) target2Count += 1;
        if (horseNige >= 2) nigeCount += 1;
      }

      // 展開バイアススコア（PlcOnCnt 相当）
      let paceScore = 0;
      if (all4Summed >= 2) paceScore += 1.0;
      else if (all4Summed === 1) paceScore += 0.5;
      if (nigeCount >= 2) paceScore += 1.5;
      else if (nigeCount === 0) paceScore -= 1.5;
      if (target2Count <= 2) paceScore -= 1.0;

      // ★の付与（距離しきい値に応じて bias とみなす）
      let paceMark: string | undefined;
      const th = card.race.distance_m <= 1600 ? 4.0 : 3.0;
      if (paceScore <= th && paceScore !== -2.5) paceMark = '★';

      meetingsMap.get(meetingKey)!.races.push({ ...card.race, pace_score: paceScore, pace_mark: paceMark, horses: card.horses });
    }

    const meetings = Array.from(meetingsMap.values()).map((m) => ({ ...m, races: m.races.sort((a, b) => a.no - b.no) }));
    const day: RaceDay = { date: ymdToDash(ymd), meetings };
    outDays.push(day);
  }

  // 既存の date{1..4}.json を読み込み、今回の分を合成して最新4件に反映
  const publicData = path.join(process.cwd(), 'public', 'data');
  ensureDir(publicData);
  const existing: RaceDay[] = [];
  for (const i of [1, 2, 3, 4]) {
    const p = path.join(publicData, `date${i}.json`);
    if (fs.existsSync(p)) {
      try {
        existing.push(JSON.parse(fs.readFileSync(p, 'utf8')) as RaceDay);
      } catch {}
    }
  }
  const merged = [...existing, ...outDays]
    .filter((d, idx, arr) => arr.findIndex((x) => x.date === d.date) === idx)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-4);
  // 最古→最新で date1→date4 に出力
  merged.forEach((d, idx) => writeJson(path.join(publicData, `date${idx + 1}.json`), d));

  await browser.close();
  console.log('Scrape complete. Wrote latest 4 days to public/data/date{1..4}.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


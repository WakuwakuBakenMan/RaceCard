import fs from 'node:fs';
import path from 'node:path';
import { getRaceList } from './raceList';
import { sleep } from './lib/http';
import { toIso } from './lib/date';
// puppeteer は環境依存のため未使用（fetch + cheerio ベースで実装）
import { chromium } from 'playwright';

type Horse = {
  num: number;
  draw: number;
  name: string;
  sex: string;
  age: number;
  weight: number;
  jockey: string;
  trainer: string;
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
type Meeting = { track: string; kaiji: number; nichiji: number; races: Race[] };
type RaceDay = { date: string; meetings: Meeting[] };

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function hostname(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}

function isHeadful(): boolean {
  return process.env.HEADFUL === '1' || process.env.SHOW === '1';
}

function useDevtools(): boolean {
  return process.env.HEADFUL_DEVTOOLS === '1' || process.env.DEVTOOLS === '1';
}

function setupRequestBlocking(page: import('playwright').Page, allowedHosts: string[]) {
  const allowHost = (h: string) =>
    allowedHosts.some((ah) => h === ah || h.endsWith('.' + ah));
  const adLike = (u: string) => /adservice|doubleclick|googletag|gpt|analytics|googlesyndication|taboola|outbrain|scorecardresearch|criteo|yads|amazon-ads|facebook|twitter|cdn\.ampproject/i.test(u);
  page.route('**/*', (route) => {
    const req = route.request();
    const url = req.url();
    const h = hostname(url);
    // Allow first-party fully (images/CSS/JS OK), but block third-party and ad endpoints
    if (!allowHost(h) || adLike(url)) {
      return route.abort();
    }
    return route.continue();
  });
}

async function savePageArtifacts(page: import('playwright').Page, stem: string) {
  try {
    const dir = path.join(process.cwd(), 'data', 'snapshots');
    ensureDir(dir);
    const html = await page.content();
    fs.writeFileSync(path.join(dir, `${stem}.html`), html, 'utf8');
    await page.screenshot({ path: path.join(dir, `${stem}.png`), fullPage: true }).catch(() => {});
    // フレーム/テーブルの簡易サマリも保存（デバッグ用途）
    try {
      const info = await page.evaluate(() => {
        function summarize(doc: Document) {
          const tables = Array.from(doc.querySelectorAll('table')) as HTMLTableElement[];
          return tables.slice(0, 8).map((tbl) => {
            const headers = Array.from(tbl.querySelectorAll('thead th')).map((th) => (th.textContent || '').trim());
            const firstRow = Array.from((tbl.querySelector('tbody tr') as HTMLTableRowElement | null)?.querySelectorAll?.('td') || [])
              .slice(0, 12)
              .map((td) => (td.textContent || '').trim());
            return { headers, firstRow };
          });
        }
        const frames: Window[] = [window].concat(
          Array.from(document.querySelectorAll('iframe'))
            .map((f) => (f as HTMLIFrameElement).contentWindow)
            .filter((w): w is Window => !!w)
        );
        return {
          url: location.href,
          frames: frames.map((w) => {
            let url = '';
            try { url = w.location?.href || ''; } catch {}
            let doc: Document | null = null;
            try { doc = w.document as Document; } catch { doc = null; }
            const tables = doc ? summarize(doc) : [];
            return { url, tables };
          }),
        };
      });
      fs.writeFileSync(path.join(dir, `${stem}-frames.json`), JSON.stringify(info, null, 2), 'utf8');
    } catch {}
  } catch {
    // ignore snapshot errors
  }
}

// 進捗の簡易ハートビートを書き出す（DEBUG_PROGRESS=1 の時のみ呼び出し）
function writeProgress(obj: Record<string, unknown>) {
  try {
    const outDir = path.join(process.cwd(), 'data');
    ensureDir(outDir);
    const file = path.join(outDir, 'progress.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ ...obj, ts: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch {
    // ignore write errors
  }
}

// Playwrightに一本化したためHTTPデコード関数は不要

async function fetchRaceCardPlaywright(
  browser: import('playwright').Browser,
  raceId: string,
  no: number
): Promise<Omit<Race, 'horses'> & { horses: Horse[] } & { _horseIds: string[] }> {
  const url = `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`;
  // レースごとに専用コンテキストを作成して干渉を避ける（UA/locale 指定）
  const ua =
    process.env.UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const ctx = await browser.newContext({ userAgent: ua, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 960 } });
  await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'ja,en;q=0.9', Referer: 'https://race.netkeiba.com/' });
  const page = await ctx.newPage();
  // 広告・サードパーティをブロックしつつ、必要な静的リソースは許可
  setupRequestBlocking(page, [
    'netkeiba.com',
    'race.netkeiba.com',
    'db.netkeiba.com',
    'img.netkeiba.com',
    'cdn.netkeiba.com',
    'cdn-sp.netkeiba.com',
    'cdn2.netkeiba.com',
    'sp.netkeiba.com',
    'db.sp.netkeiba.com',
  ]);
  // タイムアウトを広めに
  const navTimeout = Number(process.env.NAV_TIMEOUT_MS || 60000);
  page.setDefaultNavigationTimeout(navTimeout);
  page.setDefaultTimeout(navTimeout);
  // リトライ付きで遷移
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      // 必須DOM（出馬表の行）が出れば即次へ。なければbodyまでで諦めて評価に進む
      await page.waitForSelector('tr.HorseList', { timeout: Math.min(navTimeout, 20000) }).catch(() => {});
      break; // success
    } catch (e) {
      lastErr = e;
      // 軽く待って再試行
      await page.waitForTimeout(800 + attempt * 400);
      if (attempt === 2) throw e;
    }
  }
  const script = [
    '(function(){',
    'const z2h=(s)=>s.replace(/[０-９．]/g,c=>({"０":"0","１":"1","２":"2","３":"3","４":"4","５":"5","６":"6","７":"7","８":"8","９":"9","．":"."}[c]||c));',
    'const getText=(sel)=>{ const el=document.querySelector(sel); return el? (el.textContent||"").trim():""; };',
    'const raceName=getText("h1.RaceName");',
    'const d1=document.querySelector("div.RaceData01 span"); const data01=d1? (d1.textContent||"").trim():"";',
    'const m=data01.match(/(\\d{3,4})m/); const distance_m=m? Number(m[1]):0;',
    'let ground=""; if(data01.includes("芝")) ground="芝"; else if(data01.includes("ダート") || /\\bダ\\b/.test(data01)) ground="ダート"; else if(data01.includes("障")) ground="障害";',
    'const m2=(document.querySelector("div.RaceData02")?.textContent||"").match(/発走\\s*(\\d{1,2}:\\d{2})/); const start_time=m2? m2[1]:"";',
    'const rows=Array.from(document.querySelectorAll("tr.HorseList"));',
    'function pickWeight(tr){',
    '  const q=(s)=>tr.querySelector(s);',
    '  const tds=Array.from(tr.querySelectorAll("td"));',
    '  const texts=[];',
    '  const wCell=q("td.Weight"); if(wCell) texts.push(wCell.textContent||"");',
    '  const jCell=q("td.Jockey"); if(jCell && jCell.previousElementSibling) texts.push(jCell.previousElementSibling.textContent||"");',
    '  if (tds.length>4) texts.push(tds[4].textContent||"");',
    '  if (tds.length>5) texts.push(tds[5].textContent||"");',
    '  // テキストに「斤量」「負担」等があれば優先',
    '  const rowT=(tr.textContent||"");',
    '  texts.push(rowT);',
    '  for(const raw of texts){',
    '    const tx=z2h((raw||"").replace(/\\s+/g," "));',
    '    // 明示キーワードの直後',
    '    let m=tx.match(/(?:斤量|負担(?:重量)?)[^0-9]*([0-9]{2}(?:\\.[0-9])?)/);',
    '    if(m){ const v=Number(m[1]); if(v>=30 && v<=70) return v; }',
    '    // 単純に二桁（小数）',
    '    m=tx.match(/(^|\\s)([0-9]{2}(?:\\.[0-9])?)(\\s|$)/);',
    '    if(m){ const v=Number(m[2]); if(v>=30 && v<=70) return v; }',
    '  }',
    '  return 0;',
    '}',
    'const horseIds=[];',
    'const horses=rows.map(tr=>{',
    '  const q=(s)=>tr.querySelector(s);',
    '  const drawTxt=(q("td.Waku")?.textContent||q("td:nth-child(1)")?.textContent||"").trim();',
    '  const numTxt=(q("td.Umaban")?.textContent||q("td:nth-child(2)")?.textContent||"").trim();',
    '  // 行全体から馬リンクを探索（セル種別に依存しない）',
    '  const link=tr.querySelector(\'a[href*="/horse/"]\');',
    '  const href=link? (link.getAttribute("href")||""):"";',
    '  const mm=href.match(/\\/horse\\/(\\d{10})/);',
    '  const hid=mm? mm[1]:"";',
    '  if(hid) horseIds.push(hid);',
    '  const infoTd=tr.querySelector("td.HorseInfo");',
    '  const name=(infoTd?.querySelector(".HorseName")?.textContent||infoTd?.textContent||tr.querySelector(\'a[href*="/horse/"]\')?.textContent||"").trim();',
    '  const rowText=z2h((tr.textContent||"").replace(/\s+/g," "));',
    '  const sm=rowText.match(/(牡|牝|セ)\s*([0-9]+)/);',
    '  const sex=sm? sm[1]:""; const age=sm? (Number(sm[2])||0):0;',
    '  const jockey=(q("td.Jockey a")?.textContent||q("td.Jockey")?.textContent||"").trim();',
    '  const trainer=(q("td.Trainer a")?.textContent||q("td.Trainer")?.textContent||"").trim();',
    '  const weight=pickWeight(tr);',
    '  return { num: Number(numTxt||0)||0, draw: Number(drawTxt||0)||0, name, sex, age, weight, jockey, trainer };',
    '});',
    'return { raceName, distance_m, ground, start_time, horses, horseIds };',
    '})()'
  ].join('\n');
  const data = (await page.evaluate(script)) as any;
  // 馬番0や名前欠損の行は除去
  const horses: Horse[] = (data.horses as Horse[]).filter((h) => h.num > 0 && h.name);
  if ((process.env.DEBUG_SNAPSHOT === '1') && (!horses || horses.length === 0)) {
    await savePageArtifacts(page, `race-${raceId}-nohorses`);
  }
  const result = {
    no,
    name: data.raceName || `${no}R`,
    distance_m: data.distance_m,
    ground: data.ground,
    start_time: data.start_time,
    horses,
    _horseIds: (data.horseIds as string[]) || []
  };
  await page.close().catch(() => {});
  await ctx.close().catch(() => {});
  return result;
}

async function buildDay(ymd: string): Promise<RaceDay> {
  const list = await getRaceList(ymd);
  const meetings: Meeting[] = [];
  const interval = Number(process.env.SCRAPER_INTERVAL_MS || 3000);
  const horseInterval = Number(process.env.HORSE_INTERVAL_MS || process.env.SCRAPER_INTERVAL_MS || 300);
  const debug = process.env.DEBUG_PROGRESS === '1';
  const onlyTrack = process.env.ONLY_TRACK;
  const onlyRaceNo = process.env.ONLY_RACE_NO ? Number(process.env.ONLY_RACE_NO) : undefined;
  // 馬ごとの通過データは日付処理中は共有キャッシュ（ブラウザはレース単位で起動/終了）
  const horseCache = new Map<string, string[]>();
  // 実行ログのファイル出力（常時）。日付ごとに data/logs/YYYY-MM-DD.log に追記
  const logsDir = path.join(process.cwd(), 'data', 'logs');
  ensureDir(logsDir);
  const runLogPath = path.join(logsDir, `${toIso(ymd)}.log`);
  function appendRunLog(msg: string) {
    try { fs.appendFileSync(runLogPath, msg + '\n', 'utf8'); } catch {}
  }

  async function getHorsePassagesBefore(browser: import('playwright').Browser, horseId: string, yyyymmdd: string): Promise<string[]> {
    const url = `https://db.netkeiba.com/horse/${horseId}`;
    // PC向けUAでアクセス（スマホ簡易版を避けてテーブルを確実に出す）
    const ua =
      process.env.UA ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const context = await browser.newContext({
      userAgent: ua,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      viewport: { width: 1280, height: 960 },
    });
    const page = await context.newPage();                               // Page
    try { await context.setExtraHTTPHeaders({ 'Accept-Language': 'ja,en;q=0.9', Referer: 'https://db.netkeiba.com/' }); } catch {}
    // horseページのブロッキングは一旦無効化（必要要素まで止まるケースがあったため）
    // 将来はデバッグ時のみ abort URL を記録して精査する

    // page.evaluate内のconsoleを拾えるように（デバッグ時のみ）
    const debugLogs = process.env.DEBUG_PACE === '1' || process.env.DEBUG_PROGRESS === '1';
    if (debugLogs) {
      page.on('console', (msg) => {
        try { console.log(`[page:horse] ${msg.text()}`); } catch {}
      });
    }

    try {
      const NAV_TIMEOUT_MS = Number(process.env.HORSE_MAX_WAIT_MS || process.env.NAV_TIMEOUT_MS || 60000);

      if (debugLogs) console.log(`[debug] goto start: ${url}`);
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      if (debugLogs) console.log(`[debug] goto done status=${resp?.status()} url=${resp?.url()}`);

      // 欲しいDOMをピンポイントで待つ（例：馬テーブルや日付/通過テーブル）
      await page.waitForSelector('table', { timeout: Math.min(10000, NAV_TIMEOUT_MS) });
      if (debugLogs) console.log(`[debug] DOM ready for scraping`);
      
      // おまけ：短時間だけ idle を試みる（失敗しても続行）
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {
        if (debugLogs) console.log(`[debug] networkidle not reached (ignored)`);
      });
    } catch (e) {
      console.error(`[error] goto failed for ${url}:`, e);
      // ここでスナップショットを取ると原因特定が早い
      // await savePageArtifacts(page, `horse-fail-${someId}`);
      throw e;
    }

    // 成績タブがあればクリック
    try {
      const tab = page.locator('text=成績').first();
      if (await tab.count()) {
        await tab.click({ timeout: 1000 });
        await page.waitForTimeout(300);
      }
    } catch {}
    // まず最低限のtableが現れるのをポーリング（1秒間隔、最大HORSE_MAX_WAIT_MSまで）
    const minTables = Number(process.env.HORSE_TABLES_MIN || 3);
    const pollMs = Number(process.env.READY_POLL_MS || 1000);
    const maxWaitMs = Number(process.env.HORSE_MAX_WAIT_MS || process.env.NAV_TIMEOUT_MS || 20000);
    let tableCount = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < maxWaitMs) {
      tableCount = await page.evaluate(() => document.querySelectorAll('table').length).catch(() => 0);
      if (tableCount >= minTables) {
        if (debugLogs) console.log(`[debug] tables ready: ${tableCount} (min=${minTables})`);
        break;
      }
      // 途中で「通過」テキストを検出したら即抜け（軽量チェック）
      const hasPass = await page.locator('table:has-text("通過")').first().isVisible().catch(() => false);
      if (hasPass) {
        if (debugLogs) console.log(`[debug] table with 通過 detected (early ready)`);
        break;
      }
      await page.waitForTimeout(pollMs);
    }
    // 追加: デバッグ用にページのテーブル数を出力
    if (debugLogs) console.log(`[debug] Number of tables found on the page: ${tableCount}`);
    try {
      if (process.env.DEBUG_SNAPSHOT === '1' && tableCount < minTables) {
        await savePageArtifacts(page, `horse-${horseId}-tables${tableCount}`);
      }
    } catch {}

    let passages: string[] = [];
    try {
      const __date = JSON.stringify(yyyymmdd);
      const evalScript = [
        '(() => {',
        '  const dateStr = ' + __date + ';',
        '  const parseDate = (s) => {',
        '    const m = s.match(/(\\d{4})\\/(\\d{2})\\/(\\d{2})/);',
        '    if (!m) return null;',
        '    return Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);',
        '  };',
        '  const isPassage = (s) => /\\d+(-\\d+)+/.test(s);',
        '  console.log(`[debug] isPassage fn exists`);',
        '  const target = Date.parse(`${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}T00:00:00`);',
        '  const tables = Array.from(document.querySelectorAll("table"));',
        '  console.log(`[debug] target=${target} (${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}), tables.length=${tables.length}`);',
        '  const outAll = [];',
        '  for (let ti = 0; ti < tables.length; ti++) {',
        '    const tbl = tables[ti];',
        '    const rows = Array.from(tbl.querySelectorAll("tr"));',
        '    for (let ri = 0; ri < rows.length; ri++) {',
        '      const tr = rows[ri];',
        '      const cells = Array.from(tr.querySelectorAll("th,td"));',
        '      if (!cells.length) continue;',
        '      const texts = cells.map(c => (c.textContent || "").trim());',
        '      const idxDate = texts.findIndex(t => /\\d{4}\\/\\d{2}\\/\\d{2}/.test(t));',
        '      const idxPass = texts.findIndex(t => isPassage(t));',
        '      if (idxDate === -1 || idxPass === -1) continue;',
        '      const dts = parseDate(texts[idxDate]);',
        '      if (dts == null) continue;',
        '      if (dts >= target) continue;',
        '      outAll.push(texts[idxPass]);',
        '      if (outAll.length >= 3) break;',
        '    }',
        '    if (outAll.length >= 3) break;',
        '  }',
        '  return outAll;',
        '})()'
      ].join('\n');
      const result: any = await page.evaluate(evalScript);
      passages = Array.isArray(result) ? result : [];
    } catch (e) {
      console.error(`[error] evaluate failed for ${url}:`, e);
      try { if (process.env.DEBUG_SNAPSHOT === '1') await savePageArtifacts(page, `horse-eval-fail-${horseId}`); } catch {}
      passages = [];
    }
    // 取得できなかった場合のスナップショット（デバッグ時のみ）
    try {
      if (process.env.DEBUG_SNAPSHOT === '1' && (!passages || passages.length === 0)) {
        await savePageArtifacts(page, `horse-${horseId}-nopassages`);
      }
    } catch {}
    await page.close();
    await context.close();
    return passages as string[];
  }


  function computePaceScore(horsePassagesList: string[][]): number {
    let plcOnCnt = 0;
    let target2Count = 0;
    let nigeUma = 0;
    for (const passages of horsePassagesList) {
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
      if (horseAll4 >= 2) plcOnCnt += 1.0;
      else if (horseAll4 === 1) plcOnCnt += 0.5;
      if (horseAll4 >= 2) target2Count += 1;
      if (horseNige >= 2) nigeUma += 1;
    }
    if (nigeUma === 0) plcOnCnt -= 1.5;
    else if (nigeUma >= 2) plcOnCnt += 1.5;
    if (target2Count <= 2) plcOnCnt -= 1.0;
    return plcOnCnt;
  }

  for (const m of list.meetings) {
    if (onlyTrack && m.track !== onlyTrack) { if (debug) { const s = `[skip track] ${m.track}`; console.log(s); appendRunLog(s); } continue; }
    if (debug) { const s = `[meeting] ${ymd} ${m.track} ${m.kaiji}回 ${m.nichiji}日目`; console.log(s); appendRunLog(s); }
    const races: Race[] = [];
    for (const r of m.races) {
      if (onlyRaceNo && r.no !== onlyRaceNo) { if (debug) { const s = `[skip race] ${m.track} ${r.no}R`; console.log(s); appendRunLog(s); } continue; }
      if (!r.race_id) continue; // 安全側
      try {
        if (debug) { const s = `[race] ${m.track} ${r.no}R id=${r.race_id}`; console.log(s); appendRunLog(s); }
        if (debug) writeProgress({ status: 'race', date: ymd, track: m.track, no: r.no, race_id: r.race_id });
        // レース単位でブラウザを起動（HEADFUL指定時は表示・DevToolsも可）。取得後にクローズしてリセット
        const rb = await chromium.launch({ headless: !isHeadful(), devtools: useDevtools(), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        try {
          const card = await fetchRaceCardPlaywright(rb, r.race_id, r.no);
          // 展開バイアス算出（A/B/C判定とスコア）
          const horseIds = (card as any)._horseIds as string[];
          const passagesList: string[][] = [];
          for (let idx = 0; idx < horseIds.length; idx++) {
            const hid = horseIds[idx];
            if (!hid) continue;
            try {
              if (debug) { const s = `  [horse] ${idx + 1}/${horseIds.length} id=${hid}`; console.log(s); appendRunLog(s); }
              if (debug) writeProgress({ status: 'horse', date: ymd, track: m.track, no: r.no, race_id: r.race_id, horse_id: hid });
              const passages = await getHorsePassagesBefore(rb, hid, ymd);
              // === 各馬の通過ログを出す（制御は環境変数） =========================
              // DEBUG_PACE_ALL=1      … 全頭の通過を出力
              // DEBUG_PACE=1          … 取れなかった馬だけ出力（fail可視化重視）
              const DEBUG_PACE_ALL = process.env.DEBUG_PACE_ALL === '1';
              const shouldLogAll   = DEBUG_PACE_ALL;
              const shouldLogFails = process.env.DEBUG_PACE === '1' || process.env.DEBUG_PROGRESS === '1';
              const h = (card.horses && card.horses[idx]) ? (card.horses[idx] as any) : {};
              const horseTag = `num=${h?.num ?? ''} name=${h?.name ?? ''}`;
              if (shouldLogAll && passages.length > 0) {
                const line = `[debug:horse-passages] id=${hid} ${horseTag} passages=${JSON.stringify(passages)}`;
                console.log(line); appendRunLog?.(line);
              }
              if (shouldLogAll && passages.length === 0) {
                const line = `[warn:horse-passages:none] id=${hid} ${horseTag}`;
                console.warn(line); appendRunLog?.(line);
              }
              if (!shouldLogAll && shouldLogFails && passages.length === 0) {
                const line = `[warn:horse-passages:none] id=${hid} ${horseTag}`;
                console.warn(line); appendRunLog?.(line);
              }
              passagesList.push(passages);
            } catch (e) {
              // 続行（デバッグ時は馬ごとの失敗も見えるようにする）
              if (process.env.DEBUG_PACE === '1' || process.env.DEBUG_PROGRESS === '1') {
                console.warn(`[warn:horse-passages:error] id=${hid}`, e);
              }
            }
            // サイトへの負荷/RateLimit回避のために少し間隔を空ける
            if (horseInterval > 0) await sleep(horseInterval);
          }
          // 各馬のA/B/C判定
        const types: ('A'|'B'|'C')[][] = passagesList.map((ps) => {
          let all4 = 0; let nige = 0;
          for (const p of ps) {
            const parts = p.split('-').map((s) => parseInt(s,10)).filter((n)=>Number.isFinite(n));
            if (parts.length===0) continue;
            if (Math.max(...parts) <= 4) all4 += 1;
            if (parts[0] === 1) nige += 1;
          }
          const t: ('A'|'B'|'C')[] = [];
          if (nige >= 2) t.push('A');
          if (all4 >= 2) t.push('B');
          else if (all4 === 1) t.push('C');
          return t;
        });
        const validCnt = passagesList.reduce((a,ps)=>a+(ps.length>0?1:0),0);
        const pace_score = validCnt === 0 ? -3.5 : computePaceScore(passagesList);
        const pace_mark = pace_score <= 4.0 && pace_score !== -3.5 ? '★' : undefined;
        const debugPace = debug || process.env.DEBUG_PACE === '1';
        if (debugPace) {
          const total = horseIds.length;
          { const s = `[debug:passages] ${m.track} ${r.no}R ${validCnt}/${total} horses have passages`; console.log(s); appendRunLog(s); }
          if (validCnt === 0) { const s2 = `[debug:passages] ${m.track} ${r.no}R no passages found (pace=-3.5)`; console.log(s2); appendRunLog(s2); }
          // per-horse counts for anomaly detection
          try {
            const perCounts = passagesList.map((ps) => ps.length);
            const sCounts = perCounts.join(',');
            const line = `[debug:passages] ${m.track} ${r.no}R counts=[${sCounts}]`;
            console.log(line); appendRunLog?.(line);
            if (validCnt === 0 && perCounts.some((c) => c > 0)) {
              const warn = `[anomaly] ${m.track} ${r.no}R validCnt=0 but some horses have passages`;
              console.warn(warn); appendRunLog?.(warn);
            }
          } catch {}
          const detail = process.env.DEBUG_PACE_DETAIL === '1';
          if (detail) {
            for (let i=0; i<horseIds.length; i++) {
              const hid = horseIds[i];
              const pc = passagesList[i]?.length || 0;
              const t = types[i]?.join('/') || '-';
              const s3 = `  [horse] #${i+1} id=${hid} passages=${pc} types=${t}`; console.log(s3); appendRunLog(s3);
            }
          }
          { const s4 = `[debug:pace] ${m.track} ${r.no}R pace_score=${pace_score}${pace_mark? '★':''}`; console.log(s4); appendRunLog(s4); }
        }
          const horsesWithType = card.horses.map((h, i) => ({ ...h, pace_type: types[i] && types[i].length ? types[i] : undefined }));
          const raceObj = {
            no: card.no,
            name: card.name,
            distance_m: card.distance_m,
            ground: card.ground,
            start_time: card.start_time,
            pace_score,
            pace_mark,
            horses: horsesWithType
          } as Race;
          // 取得できたレースは即座にレース単位JSONとして保存
          try {
            const dateIso = toIso(ymd);
            const outDir = path.join(process.cwd(), 'data', 'races', dateIso, m.track);
            ensureDir(outDir);
            const outPath = path.join(outDir, `${raceObj.no}.json`);
            const payload = { date: dateIso, track: m.track, kaiji: m.kaiji, nichiji: m.nichiji, race: raceObj };
            fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
            if (debug) { const s = `[write] ${outPath}`; console.log(s); appendRunLog(s); }
          } catch (e) {
            console.error('write race json failed:', e);
          }
          races.push(raceObj);
          if (debug) { const s = `[pace] ${m.track} ${r.no}R score=${pace_score}${pace_mark ? '★' : ''}`; console.log(s); appendRunLog(s); }
        } finally {
          // 次レースまでインターバルを取りつつブラウザを閉じる
          await sleep(interval);
          await rb.close().catch(() => {});
        }
      } catch (e) {
        console.error(`race card fetch failed ${ymd} ${m.track} ${r.no}:`, e);
      }
    }
    races.sort((a, b) => a.no - b.no);
    meetings.push({ track: m.track, kaiji: m.kaiji, nichiji: m.nichiji, races });
  }
  const result: RaceDay = { date: toIso(ymd), meetings };
  return result;
}

function writeRaceDay(day: RaceDay) {
  const outDir = path.join(process.cwd(), 'data', 'days');
  ensureDir(outDir);
  const file = path.join(outDir, `${day.date}.json`);
  fs.writeFileSync(file, JSON.stringify(day, null, 2));
  console.log(`wrote ${file}`);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'day') {
    const ymd = process.argv[3];
    if (!ymd) {
      console.error('Usage: tsx scripts/netkeiba/build-cards.ts day YYYYMMDD');
      process.exit(1);
    }
    const day = await buildDay(ymd);
    writeRaceDay(day);
    return;
  }
  if (cmd === 'next') {
    const nextPath = path.join(process.cwd(), 'data', 'scraped', 'next_dates.json');
    if (!fs.existsSync(nextPath)) {
      console.error('next_dates.json not found. Run fetch:dates first.');
      process.exit(1);
    }
    const next = JSON.parse(fs.readFileSync(nextPath, 'utf8')) as { dates: { yyyymmdd: string }[] };
    for (const d of next.dates) {
      try {
        const day = await buildDay(d.yyyymmdd);
        writeRaceDay(day);
      } catch (e) {
        console.error(`build-cards failed for ${d.yyyymmdd}`, e);
      }
    }
    return;
  }
  console.error('Usage: build-cards.ts [day YYYYMMDD|next]');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

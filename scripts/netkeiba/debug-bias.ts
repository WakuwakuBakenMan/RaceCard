/**
 * scripts/netkeiba/debug-bias.mjs
 *
 * 目的:
 *   - 指定したレースID（race_id）の「出馬表」から全出走馬の馬IDを取得し、
 *     各馬の“対象日より前”のレースで記録された「通過順」文字列（例: "1-1-1-1"）を収集。
 *   - 収集した通過順から各馬に A/B/C タグを付与し、レース全体の展開スコア（pace_score）を計算。
 *   - 結果をコンソールに出力するデバッグ用スクリプト。
 *
 * 使い方（例）:
 *   node scripts/netkeiba/debug-bias.mjs --raceId 202501020508
 *   node scripts/netkeiba/debug-bias.mjs --raceId 202501020508 --date 20250102
 *
 * オプション:
 *   --raceId <id>   : 必須。netkeiba の race_id（YYYYMMDD + 開催場 + R番号の連結）
 *   --date  <yyyymmdd> : 任意。基準日（省略時は raceId の先頭8桁から推定）
 *
 * 主な出力:
 *   - race_id=...
 *   - 展開カウント: <数値>
 *   - 近３走中２回以上全角４以内馬（B）
 *   - 近３走中１回全角４以内馬（C）
 *   - 近３走中２走逃げ馬（A）
 *
 * 環境変数:
 *   SCRAPER_INTERVAL_MS : 馬ごとのアクセス間隔（ms）。既定 3200ms
 */

import { chromium } from 'playwright';

// ---------------------------------------------
// 定数/ユーティリティ
// ---------------------------------------------

// 馬ごとのページ遷移のインターバル（ms）
// デフォルト 3200ms。必要に応じて環境変数で上書き。
const SLEEP_MS = Number(process.env.SCRAPER_INTERVAL_MS || 3200);

// 指定ms待機する Promise
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 全角数字と全角ドットを半角に変換（表の文字列正規化用）
function z2h(s) {
  return (s || '').replace(/[０-９．]/g, (c) => ({
    '０': '0','１': '1','２': '2','３': '3','４': '4','５': '5','６': '6','７': '7','８': '8','９': '9','．': '.'
  }[c] || c));
}

// ---------------------------------------------
// 出馬表ページ → 馬名・馬IDの抽出
// ---------------------------------------------

/**
 * getShutubaHorses(page, raceId)
 *  - 出馬表: https://race.netkeiba.com/race/shutuba.html?race_id=<raceId>
 *  - 各行(tr.HorseList) から「馬名」と「馬ページURL内の馬ID」を抽出する
 *
 * @param {import('playwright').Page} page
 * @param {string} raceId
 * @returns {Promise<Array<{name: string, id: string}>>}
 */
async function getShutubaHorses(page, raceId) {
  const url = `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tr.HorseList'); // 出馬表の行が描画されるまで待つ

  // 行ごとに馬名と馬ID（/horse/<id>）を取得
  const rows = await page.$$eval('tr.HorseList', (trs) =>
    trs.map((tr) => {
      const info = tr.querySelector('td.HorseInfo');
      const name = (info?.querySelector('.HorseName')?.textContent || info?.textContent || '').trim();
      const href = info?.querySelector('a[href*="/horse/"]')?.getAttribute('href') || '';
      const m = href.match(/horse\/(\d+)/);
      const id = m ? m[1] : '';
      return { name, id };
    })
  );

  // 名前とIDが取れたものだけ返す
  return rows.filter((h) => h.name && h.id);
}

// ---------------------------------------------
// 馬ページ → 「通過」列の抽出（対象日より前を最大3件）
// ---------------------------------------------

/**
 * getHorsePassagesBefore(page, horseId, yyyymmdd)
 *  - 例: https://db.netkeiba.com/horse/2022102435
 *  - PC版の「成績」「戦績」タブを試し、テーブルの中から
 *    「日付」列と「通過」列を見つけて対象日(yyyymmdd)より前の行の通過文字列を収集。
 *  - 見つかった順に最大3件返す（空配列の場合もあり）。
 *
 * @param {import('playwright').Page} page
 * @param {string} horseId
 * @param {string} yyyymmdd
 * @returns {Promise<string[]>} passages e.g. ["1-1-1-1","4-3-2-1"]
 */
async function getHorsePassagesBefore(page, horseId, yyyymmdd) {
  const url = `https://db.netkeiba.com/horse/${horseId}`;

  // ページ遷移は最大3回リトライ（ネットワーク不安定対策）
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      break;
    } catch (e) {
      if (i === 2) throw e;
      await sleep(1000);
    }
  }

  // PC版タブを軽く叩いておく（存在する場合のみ）
  try {
    const tab = page.locator('text=成績').first();
    if (await tab.count()) { await tab.click({ timeout: 1000 }); await sleep(300); }
  } catch {}
  try {
    const tab = page.locator('text=戦績').first();
    if (await tab.count()) { await tab.click({ timeout: 1000 }); await sleep(300); }
  } catch {}

  // 何らかのテーブルが現れるまで軽く待つ（厳密でなくOK）
  await page.waitForSelector('table', { timeout: 10000 }).catch(() => {});

  // ページ内でテーブルを総当たりし、日付列/通過列を特定して抽出する
  const passages = await page.evaluate((dateStr) => {
    // "YYYY/MM/DD" → ms（ローカルタイム基準）。完全一致ではなくテキストから日付を切り出す用途。
    function parseDate(s) {
      const m = s.match(/(\d{4})\/(\d{2})\/(\d{2})/);
      if (!m) return null;
      return Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
    }

    // "1-1-1-1" のような通過文字列判定
    const isPass = (s) => /\d+(-\d+)+/.test(s);

    // 対象日（当日を含めず「前」だけを拾う）
    const target = Date.parse(
      `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}T00:00:00`
    );

    // ページ内の全テーブルを走査
    const tables = Array.from(document.querySelectorAll('table'));
    for (const tbl of tables) {
      // thead の見出しから「日付」「通過」の候補位置を探す
      const headers = Array.from(tbl.querySelectorAll('thead th')).map((th) => (th.textContent || '').trim());
      let idxDate = headers.findIndex((h) => h.includes('日付'));
      let idxPass = headers.findIndex((h) => h.includes('通過'));

      const rows = Array.from(tbl.querySelectorAll('tbody tr'));

      // 見出しで見つからない場合、先頭行のセル内容から推測
      if (idxPass === -1 && rows.length) {
        const tds = rows[0].querySelectorAll('td');
        for (let i = 0; i < tds.length; i++) {
          const tx = (tds[i].textContent || '').trim();
          if (/\d+(-\d+)+/.test(tx)) { idxPass = i; break; }
        }
      }
      if (idxDate === -1 && rows.length) {
        const tds = rows[0].querySelectorAll('td');
        for (let i = 0; i < tds.length; i++) {
          const tx = (tds[i].textContent || '').trim();
          if (/\d{4}\/\d{2}\/\d{2}/.test(tx)) { idxDate = i; break; }
        }
      }

      // どちらも特定できなければ次のテーブルへ
      if (idxPass === -1 || idxDate === -1) continue;

      // 収集開始（対象日より前の行だけ、最大3件）
      const out = [];
      for (const tr of rows) {
        const tds = Array.from(tr.querySelectorAll('td'));
        const dts = parseDate((tds[idxDate]?.textContent || '').trim());
        if (dts == null || dts >= target) continue; // 同日・未来は除外

        const pass = (tds[idxPass]?.textContent || '').trim();
        if (isPass(pass)) out.push(pass);
        if (out.length >= 3) break; // 近3走まで
      }
      if (out.length) return out; // 何か取れたら即返す
    }
    return []; // 何も取れない
  }, yyyymmdd);

  return passages;
}

// ---------------------------------------------
// 通過配列 → A/B/C タグ付け
// ---------------------------------------------

/**
 * classifyTypes(passages)
 *  - 各通過文字列を配列化（半角数値化）し、
 *    先団滞在(最大位置<=4)・逃げ(先頭位置=1) の回数から A/B/C を決定。
 *
 * 付与ルール:
 *   - 逃げが 2回以上 → 'A'
 *   - 先団(<=4) が 2回以上 → 'B'
 *   - 先団(<=4) が 1回       → 'C'（B と排他）
 *
 * @param {string[]} passages
 * @returns {('A'|'B'|'C')[]}
 */
function classifyTypes(passages) {
  let all4 = 0, nige = 0;

  for (const p of passages) {
    // "1-1-1-1" → [1,1,1,1] に変換（全角数字にも対応）
    const parts = p.split('-').map((s) => Number(z2h(s))).filter((n) => Number.isFinite(n));
    if (!parts.length) continue;

    // 1周目からゴールまでの最大順位が 4以内 → 先団滞在と見なす
    if (Math.max(...parts) <= 4) all4 += 1;

    // 1コーナー（配列先頭）が 1 → 逃げ
    if (parts[0] === 1) nige += 1;
  }

  // タグ付け
  const t = [];
  if (nige >= 2) t.push('A');
  if (all4 >= 2) t.push('B');
  else if (all4 === 1) t.push('C'); // B 付与時は C 付与しない

  return t;
}

// ---------------------------------------------
// 各馬の A/B/C 集合 → レースの pace_score
// ---------------------------------------------

/**
 * computePaceScore(allTypes)
 *  - レース内の各馬に付与された A/B/C を合成して連続値のスコアにする。
 *
 * 合成ルール（経験則的な重み付け）:
 *   - 'B' が含まれる馬: +1.0（target2++）
 *   - 'C' が含まれる馬: +0.5（ただしBとは排他）
 *   - 'A' が含まれる馬: 逃げ頭数としてカウント
 *   - 逃げ頭数が 0      : -1.5
 *   - 逃げ頭数が 2以上  : +1.5
 *   - 'B' の頭数が 2以下: -1.0
 *
 * @param {Array<Array<'A'|'B'|'C'>>} allTypes
 * @returns {number} pace_score
 */
function computePaceScore(allTypes) {
  let plcOnCnt = 0, target2 = 0, nigeUma = 0;

  for (const t of allTypes) {
    if (t.includes('B')) { plcOnCnt += 1.0; target2 += 1; }
    else if (t.includes('C')) plcOnCnt += 0.5;
    if (t.includes('A')) nigeUma += 1;
  }

  if (nigeUma === 0) plcOnCnt -= 1.5;
  else if (nigeUma >= 2) plcOnCnt += 1.5;

  if (target2 <= 2) plcOnCnt -= 1.0;

  return plcOnCnt;
}

// ---------------------------------------------
// エントリポイント
// ---------------------------------------------

/**
 * main()
 *  - 引数解析 → Playwright起動 → 出馬表→馬ID→通過収集→A/B/C→pace_score→結果出力
 *  - 例外は最後に catch して stderr に出して終了コード1
 */
async function main() {
  const args = process.argv.slice(2);

  // --raceId は必須
  const ridIdx = args.indexOf('--raceId');
  if (ridIdx === -1) {
    console.error('Usage: node scripts/netkeiba/debug-bias.mjs --raceId 202501020508 [--date YYYYMMDD]');
    process.exit(1);
  }
  const raceId = args[ridIdx + 1];

  // --date 無指定なら raceId の先頭8桁（YYYYMMDD）を使用
  const dateIdx = args.indexOf('--date');
  const ymd = dateIdx !== -1
    ? args[dateIdx + 1]
    : (raceId.slice(0, 4) + raceId.slice(4, 6) + raceId.slice(6, 8));

  // ブラウザ起動（WSLなどでも安定するフラグ）
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();

  // 出馬表 → {name, id}[] を取得
  const horses = await getShutubaHorses(page, raceId);

  // 各馬の通過を収集（対象日より前、最大3件）＋インターバル
  const allPassages = [];
  for (const h of horses) {
    const ps = await getHorsePassagesBefore(page, h.id, ymd);
    allPassages.push({ name: h.name, id: h.id, passages: ps });
    await sleep(SLEEP_MS);
  }

  // 各馬に A/B/C を付与
  const allTypes = allPassages.map((hp) => classifyTypes(hp.passages));

  // レースの pace_score を算出（誰からも通過が取れなければ特別値 -3.5）
  const score = allPassages.every((hp) => hp.passages.length === 0)
    ? -3.5
    : computePaceScore(allTypes);

  // A/B/C の馬名リストに整形（BとCは排他）
  const A = allPassages.filter((_, i) => allTypes[i].includes('A')).map((x) => x.name);
  const B = allPassages.filter((_, i) => allTypes[i].includes('B')).map((x) => x.name);
  const C = allPassages
    .filter((_, i) => allTypes[i].includes('C') && !allTypes[i].includes('B'))
    .map((x) => x.name);

  // 出力（コンソール）
  console.log(`race_id=${raceId}`);
  console.log(`展開カウント: ${score}`);
  console.log('▼近３走中２回以上全角４以内馬');
  console.log(B.join('\n'));
  console.log('◆近３走中１回全角４以内馬');
  console.log(C.join('\n'));
  console.log('★近３走中２走逃げ馬');
  console.log(A.join('\n'));

  await browser.close();
}

// 例外は stderr に出して終了コード1
main().catch((e) => { console.error(e); process.exit(1); });

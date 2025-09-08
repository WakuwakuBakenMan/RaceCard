import { chromium } from 'playwright';

const SLEEP_MS = Number(process.env.SCRAPER_INTERVAL_MS || 3200);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function z2h(s) {
  return (s || '').replace(/[０-９．]/g, (c) => ({
    '０': '0','１': '1','２': '2','３': '3','４': '4','５': '5','６': '6','７': '7','８': '8','９': '9','．': '.'
  }[c] || c));
}

async function getShutubaHorses(page, raceId) {
  const url = `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tr.HorseList');
  const rows = await page.$$eval('tr.HorseList', (trs) => trs.map((tr) => {
    const info = tr.querySelector('td.HorseInfo');
    const name = (info?.querySelector('.HorseName')?.textContent || info?.textContent || '').trim();
    const href = info?.querySelector('a[href*="/horse/"]')?.getAttribute('href') || '';
    const m = href.match(/horse\/(\d+)/);
    const id = m ? m[1] : '';
    return { name, id };
  }));
  return rows.filter((h) => h.name && h.id);
}

async function getHorsePassagesBefore(page, horseId, yyyymmdd) {
  const url = `https://db.netkeiba.com/horse/${horseId}`;
  for (let i=0;i<3;i++){
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      break;
    } catch(e) {
      if (i===2) throw e; await sleep(1000);
    }
  }
  // 成績 / 戦績 タブを試行
  try { const tab = page.locator('text=成績').first(); if (await tab.count()) { await tab.click({ timeout: 1000 }); await sleep(300);} } catch {}
  try { const tab = page.locator('text=戦績').first(); if (await tab.count()) { await tab.click({ timeout: 1000 }); await sleep(300);} } catch {}
  await page.waitForSelector('table', { timeout: 10000 }).catch(() => {});

  const passages = await page.evaluate((dateStr) => {
    function parseDate(s){ const m=s.match(/(\d{4})\/(\d{2})\/(\d{2})/); if(!m) return null; return Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00`); }
    const isPass = (s)=>/\d+(-\d+)+/.test(s);
    const target = Date.parse(`${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}T00:00:00`);
    const tables = Array.from(document.querySelectorAll('table'));
    for (const tbl of tables) {
      const headers = Array.from(tbl.querySelectorAll('thead th')).map((th)=> (th.textContent||'').trim());
      let idxDate = headers.findIndex((h)=>h.includes('日付'));
      let idxPass = headers.findIndex((h)=>h.includes('通過'));
      const rows = Array.from(tbl.querySelectorAll('tbody tr'));
      if (idxPass === -1 && rows.length) {
        const tds = rows[0].querySelectorAll('td');
        for (let i=0;i<tds.length;i++){ const tx=(tds[i].textContent||'').trim(); if (/\d+(-\d+)+/.test(tx)) { idxPass=i; break; } }
      }
      if (idxDate === -1 && rows.length) {
        const tds = rows[0].querySelectorAll('td');
        for (let i=0;i<tds.length;i++){ const tx=(tds[i].textContent||'').trim(); if (/\d{4}\/\d{2}\/\d{2}/.test(tx)) { idxDate=i; break; } }
      }
      if (idxPass === -1 || idxDate === -1) continue;
      const out=[];
      for (const tr of rows) {
        const tds = Array.from(tr.querySelectorAll('td'));
        const dts = parseDate((tds[idxDate]?.textContent||'').trim());
        if (dts == null || dts >= target) continue;
        const pass = (tds[idxPass]?.textContent||'').trim();
        if (isPass(pass)) out.push(pass);
        if (out.length >= 3) break;
      }
      if (out.length) return out;
    }
    return [];
  }, yyyymmdd);
  return passages;
}

function classifyTypes(passages){
  let all4=0, nige=0;
  for (const p of passages){
    const parts = p.split('-').map((s)=> Number(z2h(s))).filter((n)=> Number.isFinite(n));
    if (!parts.length) continue;
    if (Math.max(...parts) <= 4) all4 += 1;
    if (parts[0] === 1) nige += 1;
  }
  const t=[];
  if (nige >= 2) t.push('A');
  if (all4 >= 2) t.push('B');
  else if (all4 === 1) t.push('C');
  return t;
}

function computePaceScore(allTypes){
  let plcOnCnt=0, target2=0, nigeUma=0;
  for (const t of allTypes){
    if (t.includes('B')) { plcOnCnt += 1.0; target2 += 1; }
    else if (t.includes('C')) plcOnCnt += 0.5;
    if (t.includes('A')) nigeUma += 1;
  }
  if (nigeUma === 0) plcOnCnt -= 1.5; else if (nigeUma >= 2) plcOnCnt += 1.5;
  if (target2 <= 2) plcOnCnt -= 1.0;
  return plcOnCnt;
}

async function main(){
  const args = process.argv.slice(2);
  const ridIdx = args.indexOf('--raceId');
  if (ridIdx === -1) {
    console.error('Usage: node scripts/netkeiba/debug-bias.mjs --raceId 202501020508 [--date YYYYMMDD]');
    process.exit(1);
  }
  const raceId = args[ridIdx+1];
  const dateIdx = args.indexOf('--date');
  const ymd = dateIdx !== -1 ? args[dateIdx+1] : (raceId.slice(0,4) + raceId.slice(4,6) + raceId.slice(6,8));

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage();

  const horses = await getShutubaHorses(page, raceId);
  const allPassages=[];
  for (const h of horses){
    const ps = await getHorsePassagesBefore(page, h.id, ymd);
    allPassages.push({ name: h.name, id: h.id, passages: ps });
    await sleep(SLEEP_MS);
  }

  const allTypes = allPassages.map((hp)=> classifyTypes(hp.passages));
  const score = allPassages.every((hp)=> hp.passages.length===0) ? -3.5 : computePaceScore(allTypes);

  const A = allPassages.filter((_, i)=> allTypes[i].includes('A')).map(x=>x.name);
  const B = allPassages.filter((_, i)=> allTypes[i].includes('B')).map(x=>x.name);
  const C = allPassages.filter((_, i)=> allTypes[i].includes('C') && !allTypes[i].includes('B')).map(x=>x.name);

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

main().catch((e)=>{ console.error(e); process.exit(1); });

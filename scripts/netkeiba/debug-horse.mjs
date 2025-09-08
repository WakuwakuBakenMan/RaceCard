import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const SLEEP_MS = Number(process.env.SCRAPER_INTERVAL_MS || 3200);
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function z2h(s){ return (s||'').replace(/[０-９．]/g, c => ({'０':'0','１':'1','２':'2','３':'3','４':'4','５':'5','６':'6','７':'7','８':'8','９':'9','．':'.'}[c]||c)); }

function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }

async function saveArtifacts(page, stem){
  try{
    const dir = path.join(process.cwd(), 'data', 'snapshots');
    ensureDir(dir);
    const html = await page.content();
    fs.writeFileSync(path.join(dir, `${stem}.html`), html, 'utf8');
    await page.screenshot({ path: path.join(dir, `${stem}.png`), fullPage: true }).catch(()=>{});
    // frames/tables summary
    const info = await page.evaluate(() => {
      function summarize(doc){
        const tables = Array.from(doc.querySelectorAll('table'));
        return tables.slice(0, 6).map(tbl => {
          const headers = Array.from(tbl.querySelectorAll('thead th')).map(th => (th.textContent||'').trim());
          const firstRow = Array.from((tbl.querySelector('tbody tr')||{}).querySelectorAll?.('td')||[]).slice(0,10).map(td => (td.textContent||'').trim());
          return { headers, firstRow };
        });
      }
      const frames = [window].concat(Array.from(document.querySelectorAll('iframe')).map(f=>f.contentWindow).filter(Boolean));
      return { url: location.href, frames: frames.map(w=>({ url: w.location?.href||'', tables: summarize(w.document) })) };
    });
    fs.writeFileSync(path.join(dir, `${stem}-frames.json`), JSON.stringify(info,null,2), 'utf8');
  }catch{}
}

async function getHorsePassagesBefore(page, horseId, yyyymmdd){
  const url = `https://db.netkeiba.com/horse/${horseId}`;
  // ページ遷移（最大3回リトライ）
  for (let i=0;i<3;i++){
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); break; }
    catch (e){ if (i===2) throw e; await sleep(1000); }
  }
  // 成績/戦績タブを試行
  try { const t = page.locator('text=成績').first(); if (await t.count()) { await t.click({ timeout: 1000 }); await sleep(300);} } catch {}
  try { const t = page.locator('text=戦績').first(); if (await t.count()) { await t.click({ timeout: 1000 }); await sleep(300);} } catch {}
  await page.waitForSelector('table', { timeout: 10000 }).catch(()=>{});
  if (process.env.DEBUG_SNAPSHOT === '1') await saveArtifacts(page, `horse-${horseId}-pc`);

  // 複数回評価して通過/日付列を検出
  for (let attempt=0; attempt<12; attempt++){
    const res = await page.evaluate((dateStr) => {
      function parseDate(s){ const m=s.match(/(\d{4})\/(\d{2})\/(\d{2})/); if(!m) return null; return Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00`); }
      const isPass = (s)=>/\d+(-\d+)+/.test(s);
      const target = Date.parse(`${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}T00:00:00`);
      const tables = Array.from(document.querySelectorAll('table'));
      for (const tbl of tables){
        const headers = Array.from(tbl.querySelectorAll('thead th')).map(th => (th.textContent||'').trim());
        let idxDate = headers.findIndex(h=>h.includes('日付'));
        let idxPass = headers.findIndex(h=>h.includes('通過'));
        const rows = Array.from(tbl.querySelectorAll('tbody tr'));
        if (idxPass === -1 && rows.length){
          const tds = rows[0].querySelectorAll('td');
          for (let i=0;i<tds.length;i++){ const tx=(tds[i].textContent||'').trim(); if (/\d+(-\d+)+/.test(tx)) { idxPass=i; break; } }
        }
        if (idxDate === -1 && rows.length){
          const tds = rows[0].querySelectorAll('td');
          for (let i=0;i<tds.length;i++){ const tx=(tds[i].textContent||'').trim(); if (/\d{4}\/\d{2}\/\d{2}/.test(tx)) { idxDate=i; break; } }
        }
        if (idxPass === -1 || idxDate === -1) continue;
        const out=[];
        for (const tr of rows){
          const tds = tr.querySelectorAll('td');
          const dts = parseDate((tds[idxDate]?.textContent||'').trim());
          if (dts==null || dts >= target) continue;
          const pass = (tds[idxPass]?.textContent||'').trim();
          if (/\d+(-\d+)+/.test(pass)) out.push(pass);
          if (out.length>=3) break;
        }
        if (out.length) return out;
      }
      return [];
    }, yyyymmdd);
    if (res.length) return res;
    await sleep(800);
  }
  return [];
}

function classifyTypes(passages){
  let all4=0, nige=0;
  for (const p of passages){
    const parts = p.split('-').map(s=>Number(z2h(s))).filter(n=>Number.isFinite(n));
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

async function main(){
  const args = process.argv.slice(2);
  const hidIdx = args.indexOf('--horseId');
  const dateIdx = args.indexOf('--date');
  if (hidIdx === -1 || dateIdx === -1){
    console.error('Usage: node scripts/netkeiba/debug-horse.mjs --horseId 2022102435 --date 20250906');
    process.exit(1);
  }
  const horseId = args[hidIdx+1];
  const ymd = args[dateIdx+1];
  const headful = process.env.HEADFUL === '1' || process.env.SHOW === '1';
  const devtools = process.env.HEADFUL_DEVTOOLS === '1' || process.env.DEVTOOLS === '1';
  const browser = await chromium.launch({ headless: !headful, devtools, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const passages = await getHorsePassagesBefore(page, horseId, ymd);
  const types = classifyTypes(passages);
  console.log({ horseId, ymd, passages, types });
  if (process.env.DEBUG_SNAPSHOT === '1' && (!passages || passages.length===0)){
    await saveArtifacts(page, `horse-${horseId}-pc-nopassage`);
  }
  await browser.close();
}

main().catch(e=>{ console.error(e); process.exit(1); });

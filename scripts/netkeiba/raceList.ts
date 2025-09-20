import { chromium } from 'playwright';
// toAbsoluteUrl はブラウザ内でURL解決するため未使用

export type RaceLink = { no: number; name?: string; url: string; race_id?: string };
export type Meeting = { title: string; kaiji: number; track: string; nichiji: number; races: RaceLink[] };
export type RaceDayList = { date: string; meetings: Meeting[] };

const LIST_URL = (d: string) => `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${d}`;

// TITLE_RE はブラウザ評価側に埋め込み

export async function getRaceList(yyyymmdd: string): Promise<RaceDayList> {
  const url = LIST_URL(yyyymmdd);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // 一部日でレースリンクが遅延描画され、11R等の注目レースしか取れないことがある。
  // そこで少し待機し、レースリンクが十分に揃うのを待つ。
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 });
  } catch {}
  try {
    // 少なくともいずれかのレースリンクが現れるまで待機
    await page.waitForSelector('a[href*="race/shutuba.html?race_id="]', { timeout: 8000 });
  } catch {}
  // それでも少ない場合は短いポーリングで最大数秒観察
  try {
    const t0 = Date.now();
    const maxWait = 6000;
    let lastCount = 0;
    while (Date.now() - t0 < maxWait) {
      const cnt = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="race/shutuba.html?race_id="]')).length
      ).catch(() => 0);
      if (cnt >= 20 || cnt === lastCount) break; // 目安: 2会場×10R以上 or 変化が止まった
      lastCount = cnt;
      await page.waitForTimeout(300);
    }
  } catch {}
  const script = [
    '(function(){',
    'const TITLE_RE=/(\\d+)\\s*回\\s*([^\\s]+)\\s*(\\d+)\\s*日目/;',
    'const all=Array.from(document.querySelectorAll("body *"));',
    'const titleIdxs=[];',
    'for(let i=0;i<all.length;i++){const txt=(all[i].textContent||"").trim();if(TITLE_RE.test(txt)) titleIdxs.push(i);}',
    'const meetingMap=new Map();',
    'const parseRaceNo=(text,href)=>{const m=text.match(/(\\d+)\\s*R/);if(m) return Number(m[1]);const m2=href.match(/race_id=(\\d{10})(\\d{2})/);if(m2) return Number(m2[2]);return 0;};',
    'const toAbs=(href)=>new URL(href,location.href).toString();',
    'const pushRange=(start,end)=>{',
    '  const titleEl=all[start];',
    '  const titleText=(titleEl.textContent||"").trim();',
    '  const m=titleText.match(TITLE_RE);',
    '  if(!m) return;',
    '  const kaiji=Number(m[1]);',
    '  const track=m[2];',
    '  const nichiji=Number(m[3]);',
    '  const slice=all.slice(start+1,end);',
    '  const anchors=[];',
    '  for(const e of slice){ if(e.tagName && e.tagName.toLowerCase()==="a") anchors.push(e); anchors.push(...Array.from(e.querySelectorAll("a"))); }',
    '  const seen=new Set();',
    '  const races=[];',
    '  for(const a of anchors){ const href=a.getAttribute("href")||""; const text=(a.textContent||"").trim(); const mId=href.match(/race_id=(\\d{12})/); if(!mId) continue; const abs=toAbs(href); if(seen.has(mId[1])) continue; const no=parseRaceNo(text,href); races.push({no,name:text||undefined,url:abs,race_id:mId[1]}); seen.add(mId[1]); }',
    '  const key=kaiji+"|"+track+"|"+nichiji;',
    '  const title=kaiji+"回 "+track+" "+nichiji+"日目";',
    '  if(!meetingMap.has(key)) meetingMap.set(key,{title,kaiji,track,nichiji,races:[]});',
    '  const existing=meetingMap.get(key);',
    '  const seen2=new Set(existing.races.map(r=>r.race_id||r.url));',
    '  for(const r of races) if(!seen2.has(r.race_id||r.url)) existing.races.push(r);',
    '  existing.races.sort((a,b)=>a.no-b.no);',
    '};',
    'for(let i=0;i<titleIdxs.length;i++){ const start=titleIdxs[i]; const end=i+1<titleIdxs.length?titleIdxs[i+1]:all.length; pushRange(start,end); }',
    'return { meetings: Array.from(meetingMap.values()) };',
    '})()'
  ].join('\n');
  const data = (await page.evaluate(script)) as any;
  await browser.close();
  return { date: yyyymmdd, meetings: (data.meetings as any) as Meeting[] };
}

// parseRaceNo はブラウザ評価側に実装

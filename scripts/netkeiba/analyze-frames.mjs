import fs from 'node:fs';
import path from 'node:path';

function usage(){
  console.error('Usage: node scripts/netkeiba/analyze-frames.mjs --file data/snapshots/horse-<id>-frames.json [--date YYYYMMDD]');
  process.exit(1);
}

function toTargetTs(s){
  if (!s) return null;
  if (/^\d{8}$/.test(s)) return Date.parse(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00`);
  return null;
}

function isPassage(s){ return /\d+(-\d+)+/.test((s||'').trim()); }

function main(){
  const args = process.argv.slice(2);
  const fIdx = args.indexOf('--file');
  if (fIdx === -1) usage();
  const file = args[fIdx+1];
  const dIdx = args.indexOf('--date');
  const targetTs = toTargetTs(dIdx!==-1 ? args[dIdx+1] : '');
  const json = JSON.parse(fs.readFileSync(file,'utf8'));
  const findings = [];
  for (const fr of json.frames||[]){
    for (const tbl of fr.tables||[]){
      const headers = tbl.headers||[];
      let idxPass = headers.findIndex(h=>h.includes('通過')||h.includes('通過順')||h.includes('通過順位'));
      let idxDate = headers.findIndex(h=>h.includes('日付'));
      findings.push({ frameUrl: fr.url, headers, idxPass, idxDate, preview: tbl.firstRow });
    }
  }
  console.log(JSON.stringify({ file, targetTs, findings }, null, 2));
}

main();


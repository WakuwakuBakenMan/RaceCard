import fs from 'node:fs';
import path from 'node:path';

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function toYmdDash(s) {
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return undefined;
}

function extractDateFromContent(json) {
  if (json && typeof json.date === 'string') return json.date;
  return undefined;
}

function parseDateFromFilename(fn) {
  const m1 = fn.match(/(\d{8})/);
  if (m1) return toYmdDash(m1[1]);
  const m2 = fn.match(/(\d{4}-\d{2}-\d{2})/);
  if (m2) return m2[1];
  return undefined;
}

function main() {
  const inDir = process.env.IN_DIR || path.join(process.cwd(), 'data', 'days');
  const outDir = path.join(process.cwd(), 'public', 'data');
  ensureDir(outDir);
  if (!fs.existsSync(inDir)) {
    console.error(`Input dir not found: ${inDir}`);
    process.exit(1);
  }
  // RaceDayのみ対象（reco-*.json を除外）
  const files = fs.readdirSync(inDir).filter((f) => /\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const items = [];
  for (const f of files) {
    try {
      const full = path.join(inDir, f);
      const json = JSON.parse(fs.readFileSync(full, 'utf8'));
      const date = extractDateFromContent(json) || parseDateFromFilename(f);
      if (!date) continue;
      items.push({ date, full });
    } catch (e) {
      console.error(`Skip broken file: ${f}`, e);
    }
  }
  const sorted = items.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-4);
  sorted.forEach((it, i) => {
    const out = path.join(outDir, `date${i + 1}.json`);
    fs.copyFileSync(it.full, out);
    console.log(`copied ${it.full} -> ${out}`);
  });
}

try { main(); } catch (e) { console.error(e); process.exit(1); }


import fs from 'node:fs';
import path from 'node:path';

type DayReco = { date: string } & Record<string, unknown>;

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function toYmdDash(s: string): string | undefined {
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return undefined;
}

function extractDateFromContent(json: any): string | undefined {
  if (json && typeof json.date === 'string') return json.date;
  return undefined;
}

function parseDateFromFilename(fn: string): string | undefined {
  const m1 = fn.match(/(\d{8})/);
  if (m1) return toYmdDash(m1[1]);
  const m2 = fn.match(/(\d{4}-\d{2}-\d{2})/);
  if (m2) return m2[1];
  return undefined;
}

function main() {
  // 入力は data/days（reco-YYYY-MM-DD.json）
  const inDir = process.env.IN_DIR || path.join(process.cwd(), 'data', 'days');
  const outDir = path.join(process.cwd(), 'public', 'data');
  ensureDir(outDir);
  if (!fs.existsSync(inDir)) {
    console.error(`Input dir not found: ${inDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(inDir).filter((f) => /^reco-.*\.json$/.test(f));
  const items: { date: string; full: string }[] = [];
  for (const f of files) {
    try {
      const full = path.join(inDir, f);
      const json = JSON.parse(fs.readFileSync(full, 'utf8')) as DayReco;
      const date = extractDateFromContent(json) || parseDateFromFilename(f);
      if (!date) continue;
      items.push({ date, full });
    } catch (e) {
      console.error(`Skip broken file: ${f}`, e);
    }
  }

  const sorted = items.sort((a, b) => (a.date < b.date ? -1 : 1));
  const uniqRev: { date: string; full: string }[] = [];
  const seen = new Set<string>();
  for (let i = sorted.length - 1; i >= 0 && uniqRev.length < 4; i--) {
    const it = sorted[i];
    if (seen.has(it.date)) continue;
    seen.add(it.date);
    uniqRev.push(it);
  }
  const uniq = uniqRev.reverse();

  // 既存の reco*.json を一旦削除
  for (let i = 1; i <= 4; i++) {
    const p = path.join(outDir, `reco${i}.json`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  // 存在する件数のみを出力
  uniq.forEach((it, i) => {
    const out = path.join(outDir, `reco${i + 1}.json`);
    fs.copyFileSync(it.full, out);
    console.log(`copied ${it.full} -> ${out}`);
  });
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}



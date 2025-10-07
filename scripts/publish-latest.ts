import fs from 'node:fs';
import path from 'node:path';

type RaceDay = { date: string; meetings: unknown[] };

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function toYmdDash(s: string): string | undefined {
  // from YYYYMMDD or YYYY-MM-DD
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
  const inDir = process.env.IN_DIR || path.join(process.cwd(), 'data', 'days');
  const outDir = path.join(process.cwd(), 'public', 'data');
  ensureDir(outDir);
  if (!fs.existsSync(inDir)) {
    console.error(`Input dir not found: ${inDir}`);
    process.exit(1);
  }

  // RaceDayのみ対象（reco-*.json を除外）
  const files = fs.readdirSync(inDir).filter((f) => /\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.startsWith('reco-'));
  const items: { date: string; full: string }[] = [];
  for (const f of files) {
    try {
      const full = path.join(inDir, f);
      const json = JSON.parse(fs.readFileSync(full, 'utf8')) as RaceDay;
      const date = extractDateFromContent(json) || parseDateFromFilename(f);
      if (!date) continue;
      items.push({ date, full });
    } catch (e) {
      console.error(`Skip broken file: ${f}`, e);
    }
  }

  const sorted = items.sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(`Found ${sorted.length} day files:`, sorted.map(s => s.date));
  
  // 後ろ（新しい日付側）からユニークに最大4件取得
  const uniqRev: { date: string; full: string }[] = [];
  const seen = new Set<string>();
  for (let i = sorted.length - 1; i >= 0 && uniqRev.length < 4; i--) {
    const it = sorted[i];
    if (seen.has(it.date)) continue;
    seen.add(it.date);
    uniqRev.push(it);
  }
  const uniq = uniqRev.reverse();
  console.log(`Selected ${uniq.length} unique days:`, uniq.map(u => u.date));

  // 既存の date*.json を一旦削除（古い日の残骸で重複が見えるのを防ぐ）
  for (let i = 1; i <= 4; i++) {
    const p = path.join(outDir, `date${i}.json`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  // 最新から順に詰めて出力（存在する件数のみ）
  uniq.forEach((it, i) => {
    const out = path.join(outDir, `date${i + 1}.json`);
    // ファイル内容を検証
    const content = fs.readFileSync(it.full, 'utf8');
    const json = JSON.parse(content);
    if (!json.meetings || !Array.isArray(json.meetings)) {
      console.error(`ERROR: ${it.full} is not a valid RaceDay (missing meetings)`);
      console.error(`Content preview:`, JSON.stringify(json, null, 2).substring(0, 200));
      process.exit(1);
    }
    fs.copyFileSync(it.full, out);
    console.log(`copied ${it.full} -> ${out} (${json.meetings.length} meetings)`);
  });
}

// ESM 実行
try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}

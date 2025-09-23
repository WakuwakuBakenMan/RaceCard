import type { PositionBiasForGround } from '@/lib/types';

type Props = {
  bias?: PositionBiasForGround;
};

// 強=塗りつぶし、なし/不足=非表示
export default function BiasChips({ bias }: Props) {
  if (!bias) return null;

  const chips: Array<{ key: string; label: string; style: 'strong' | 'flat'; title?: string }> = [];

  // 脚質（優先順位: 複勝 → 連対 → 穴）
  const p = bias.pace;
  const target = (p?.win_place?.target ?? p?.quinella?.target ?? p?.longshot?.target) ?? null;
  const paceLabel = target === 'A' ? '先行' : target === 'B' ? '差し' : target === 'C' ? 'その他' : 'フラット';
  const paceStyle: 'strong' | 'flat' = target ? 'strong' : 'flat';
  chips.push({ key: 'pace', label: paceLabel, style: paceStyle, title: formatPaceTitle(p) });

  // 枠（内/外）
  const d = bias.draw;
  const drawTarget = d?.target ?? null;
  const drawLabel = drawTarget === 'inner' ? '内枠' : drawTarget === 'outer' ? '外枠' : 'フラット';
  const drawStyle: 'strong' | 'flat' = drawTarget ? 'strong' : 'flat';
  chips.push({ key: 'draw', label: drawLabel, style: drawStyle, title: formatDrawTitle(d) });

  return (
    <div className="inline-flex items-center gap-1 align-middle">
      {chips.map((c) => (
        <span
          key={c.key}
          title={c.title}
          className={
            c.style === 'strong'
              ? 'text-xs px-1.5 py-0.5 rounded font-semibold bg-emerald-600 text-white'
              : 'text-xs px-1.5 py-0.5 rounded font-semibold bg-gray-300 text-gray-800'
          }
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

function formatPaceTitle(p?: PositionBiasForGround['pace']): string | undefined {
  if (!p) return undefined;
  const segs: string[] = [];
  if (p.win_place?.target) segs.push(`複勝: 脚${p.win_place.target}${fmtRate(p.win_place)}`);
  if (p.quinella?.target) segs.push(`連対: 脚${p.quinella.target}${fmtRate(p.quinella)}`);
  if (p.longshot?.target) segs.push(`穴: 脚${p.longshot.target}${fmtRate(p.longshot)}`);
  return segs.length ? segs.join(' / ') : undefined;
}

function formatDrawTitle(d?: PositionBiasForGround['draw']): string | undefined {
  if (!d?.target) return undefined;
  const label = d.target === 'inner' ? '内' : '外';
  return `${label}${fmtRate(d)}`;
}

function fmtRate(x?: { ratio?: number; n_total?: number }): string {
  const xs: string[] = [];
  if (typeof x?.ratio === 'number') xs.push(`${Math.round(x.ratio * 100)}%`);
  if (typeof x?.n_total === 'number') xs.push(`n=${x.n_total}`);
  return xs.length ? ` (${xs.join(', ')})` : '';
}



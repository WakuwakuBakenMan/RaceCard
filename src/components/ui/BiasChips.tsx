import type { PositionBiasForGround } from '@/lib/types';

type Props = {
  bias?: PositionBiasForGround;
};

// 強=塗りつぶし、なし/不足=非表示
export default function BiasChips({ bias }: Props) {
  if (!bias) return null;

  const chips: Array<{ key: string; label: string; strong: boolean; title?: string }> = [];

  // 脚質（複勝/連対/穴）から、代表1つを要約（強いもののみ）
  const p = bias.pace;
  const parts: string[] = [];
  if (p?.win_place?.target) parts.push(`脚${p.win_place.target}`);
  if (p?.quinella?.target && !parts.includes(`脚${p.quinella.target}`)) parts.push(`脚${p.quinella.target}`);
  if (p?.longshot?.target && !parts.includes(`脚${p.longshot.target}`)) parts.push(`脚${p.longshot.target}`);
  if (parts.length > 0) {
    const title = formatPaceTitle(p);
    chips.push({ key: 'pace', label: parts.join('・'), strong: true, title });
  }

  // 枠（内/外）
  if (bias.draw?.target) {
    const label = bias.draw.target === 'inner' ? '内' : '外';
    const title = formatDrawTitle(bias.draw);
    chips.push({ key: 'draw', label, strong: true, title });
  }

  if (chips.length === 0) return null;

  return (
    <div className="inline-flex items-center gap-1 align-middle">
      {chips.map((c) => (
        <span
          key={c.key}
          title={c.title}
          className={`text-xs px-1.5 py-0.5 rounded font-semibold ${c.strong ? 'bg-emerald-600 text-white' : 'border border-emerald-600 text-emerald-700'}`}
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



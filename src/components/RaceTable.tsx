import { useEffect, useMemo, useState } from 'react';
import { loadDayByDate } from '@/lib/dataLoader';
import type { Horse, Race, RaceDay } from '@/lib/types';
import { useParams, Link } from 'react-router-dom';
import FrameBadge from '@/components/ui/FrameBadge';
import { formatRaceHeader } from '@/lib/utils';
import BiasChips from '@/components/ui/BiasChips';

type SortKey = 'popularity' | 'odds' | 'num';

export default function RaceTable() {
  const { date, track, no } = useParams();
  const [day, setDay] = useState<RaceDay | undefined>();
  const [sortKey, setSortKey] = useState<SortKey>('num');
  const [asc, setAsc] = useState<boolean>(true);

  useEffect(() => {
    if (!date) return;
    loadDayByDate(date).then(setDay);
  }, [date]);

  const race: Race | undefined = useMemo(() => {
    if (!day || !track || !no) return undefined;
    const meeting = day.meetings.find((m) => m.track === track);
    return meeting?.races.find((r) => r.no === Number(no));
  }, [day, track, no]);

  const horses: Horse[] = useMemo(() => {
    if (!race) return [];
    const sorted = [...race.horses].sort((a, b) => {
      const k = sortKey;
      const av = (a as any)[k] ?? Infinity;
      const bv = (b as any)[k] ?? Infinity;
      if (av === bv) return a.num - b.num;
      return av < bv ? -1 : 1;
    });
    return asc ? sorted : sorted.reverse();
  }, [race, sortKey, asc]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setAsc(!asc);
    else {
      setSortKey(k);
      setAsc(true);
    }
  }

  if (!date || !track || !no) return <div>パラメータが不正です。</div>;

  return (
    <div className="space-y-3">
      <div>
        <Link
          to={`/d/${date}`}
          className="text-sm text-blue-600 hover:underline"
        >
          ← {date} の一覧へ戻る
        </Link>
      </div>
      {!race ? (
        <div>読み込み中…</div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-lg font-bold">
              {formatRaceHeader({
                track,
                no: race.no,
                pace_score: race.pace_score,
                pace_mark: race.pace_mark,
                distance_m: race.distance_m,
                ground: race.ground,
                course_note: race.course_note,
                condition: race.condition,
                start_time: race.start_time,
              })}
            </h1>
            {/* レースの馬場に対応する開催バイアスを右側に表示（強のみ） */}
            {(() => {
              const meeting = day?.meetings.find((m) => m.track === track);
              const groundKey = race.ground === '芝' ? '芝' : (race.ground === 'ダート' ? 'ダート' : race.ground);
              const b = meeting?.position_bias?.[groundKey];
              return b ? (
                <div className="text-sm">
                  <BiasChips bias={b} />
                </div>
              ) : null;
            })()}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full table-sticky border-collapse">
              <thead>
                <tr className="bg-gray-100">
                  <Th
                    onClick={() => toggleSort('num')}
                    active={sortKey === 'num'}
                    asc={asc}
                  >
                    馬番
                  </Th>
                  <th className="p-2 text-left border">枠</th>
                  <th className="p-2 text-left border">展開</th>
                  <th className="p-2 text-left border">馬名</th>
                  <th className="p-2 text-left border">性齢</th>
                  <th className="p-2 text-left border">斤量</th>
                  <th className="p-2 text-left border">騎手</th>
                  <th className="p-2 text-left border">厩舎</th>
                  <Th
                    onClick={() => toggleSort('popularity')}
                    active={sortKey === 'popularity'}
                    asc={asc}
                  >
                    人気
                  </Th>
                  <Th
                    onClick={() => toggleSort('odds')}
                    active={sortKey === 'odds'}
                    asc={asc}
                  >
                    オッズ
                  </Th>
                </tr>
              </thead>
              <tbody>
                {horses.map((h, idx) => (
                  <tr
                    key={h.num}
                    className={
                      idx % 2 === 0
                        ? 'bg-white'
                        : 'bg-gray-50 hover:bg-gray-100'
                    }
                  >
                    <td className="p-2 border text-right w-14">{h.num}</td>
                    <td className="p-2 border w-14">
                      <FrameBadge draw={h.draw} />
                    </td>
                    <td className="p-2 border whitespace-nowrap">{h.pace_type?.join('/') ?? '-'}</td>
                    <td className="p-2 border whitespace-nowrap">{h.name}</td>
                    <td className="p-2 border">
                      {h.sex}
                      {h.age}
                    </td>
                    <td className="p-2 border text-right">{typeof h.weight === 'number' ? h.weight.toFixed(1) : '-'}</td>
                    <td className="p-2 border">{h.jockey}</td>
                    <td className="p-2 border">{h.trainer}</td>
                    <td className="p-2 border text-right">
                      {h.popularity ?? '-'}
                    </td>
                    <td className="p-2 border text-right">{typeof h.odds === 'number' ? h.odds.toFixed(1) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Th({
  children,
  onClick,
  active,
  asc,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  asc: boolean;
}) {
  return (
    <th
      className={`p-2 text-left border cursor-pointer select-none ${active ? 'text-blue-700' : ''}`}
      onClick={onClick}
      title="クリックで昇順/降順切替"
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {active ? <span className="text-xs">{asc ? '▲' : '▼'}</span> : null}
      </span>
    </th>
  );
}

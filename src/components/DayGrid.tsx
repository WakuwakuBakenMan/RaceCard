import { useEffect, useMemo, useState } from 'react';
import { loadDayByDate } from '@/lib/dataLoader';
import type { RaceDay } from '@/lib/types';
import BiasChips from '@/components/ui/BiasChips';
import { Link, useParams } from 'react-router-dom';

export default function DayGrid() {
  const { date } = useParams();
  const [day, setDay] = useState<RaceDay | undefined>();

  useEffect(() => {
    if (!date) return;
    loadDayByDate(date).then(setDay);
  }, [date]);

  const maxR = useMemo(() => {
    if (!day) return 12;
    return Math.max(...day.meetings.map((m) => m.races.length));
  }, [day]);

  if (!date) return <div>日付が不正です。</div>;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{date} の出馬表</h1>
      {!day ? (
        <div>読み込み中…</div>
      ) : (
        <div className="space-y-6">
          {day.meetings.map((m) => (
            <section key={m.track} className="border rounded bg-white">
              <header className="px-3 py-2 bg-cyan-50 border-b border-cyan-100 font-semibold flex items-center justify-between gap-2">
                <div>
                  {m.kaiji}回 {m.track} {m.nichiji}日目
                </div>
                <div className="text-sm font-normal">
                  {/* 芝/ダートのバイアスを並べる（強のみ表示） */}
                  <span className="inline-flex items-center gap-2">
                    <span className="inline-flex items-center gap-1">
                      <span className="text-gray-600">芝</span>
                      <BiasChips bias={m.position_bias?.['芝']} />
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="text-gray-600">ダ</span>
                      <BiasChips bias={m.position_bias?.['ダート'] || m.position_bias?.['ダ']} />
                    </span>
                  </span>
                </div>
              </header>
              <div className="p-3 grid md:grid-cols-4 sm:grid-cols-2 grid-cols-1 gap-3">
                {Array.from({ length: maxR }).map((_, i) => {
                  const r = m.races.find((x) => x.no === i + 1);
                  const to = `/r/${day.date}/${m.track}/${i + 1}`;
                  return (
                    <Link
                      key={i}
                      to={to}
                      className={`block rounded border p-2 hover:bg-gray-50 ${
                        r ? 'opacity-100' : 'opacity-60'
                      }`}
                    >
                      <div className="text-sm text-gray-500">
                        {m.track} {i + 1}R
                      </div>
                      <div className="font-semibold">{r?.name ?? '未設定'}</div>
                      <div className="text-sm text-gray-600">
                        展開カウント: {r?.pace_score ?? '-'}{' '}
                        {r?.pace_mark ?? ''}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

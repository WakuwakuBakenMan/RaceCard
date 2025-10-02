import { useEffect, useMemo, useState } from 'react';
import { loadDayByDate, loadRecoByDate, type DayReco } from '@/lib/dataLoader';
import type { RaceDay } from '@/lib/types';
import BiasChips from '@/components/ui/BiasChips';
import { Link, useParams } from 'react-router-dom';

export default function DayGrid() {
  const { date } = useParams();
  const [day, setDay] = useState<RaceDay | undefined>();
  const [reco, setReco] = useState<DayReco | undefined>();

  useEffect(() => {
    if (!date) return;
    loadDayByDate(date).then(setDay);
    loadRecoByDate(date).then(setReco);
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
                  const hasReco = !!reco?.races.some((x) => {
                    const xt = (x.track ?? '').trim();
                    const mt = (m.track ?? '').trim();
                    if (xt !== mt || Number(x.no) !== (i + 1)) return false;
                    // 単勝/複勝/馬連BOX の明示推奨
                    const explicit = (Array.isArray(x.win) && x.win.length>0)
                      || (Array.isArray(x.place) && x.place.length>0)
                      || (Array.isArray(x.quinella_box) && x.quinella_box.length>0);
                    const notes = Array.isArray(x.notes) ? x.notes : [];
                    const noteReco = notes.some((n) => {
                      if (typeof n !== 'string') return false;
                      const s = n.trim();
                      return /^(推奨|準推奨)\s*[:：]?/.test(s) || s.includes('推奨') || (s.includes('ROI') && s.includes('馬連'));
                    });
                    return explicit || noteReco;
                  });
                  return (
                    <Link
                      key={i}
                      to={to}
                      className={`block rounded border p-2 hover:bg-gray-50 ${
                        r ? 'opacity-100' : 'opacity-60'
                      } ${hasReco ? 'ring-2 ring-amber-400 bg-amber-50' : ''}`}
                    >
                      <div className="text-sm text-gray-500">
                        {m.track} {i + 1}R
                      </div>
                      <div className="font-semibold">{r?.name ?? '未設定'}</div>
                      {hasReco ? (
                        <div className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-100 px-1 py-0.5 rounded mt-1">推奨あり</div>
                      ) : null}
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

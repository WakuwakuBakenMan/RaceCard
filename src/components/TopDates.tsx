import { useEffect, useState } from 'react';
import { loadAllDays } from '@/lib/dataLoader';
import type { RaceDay } from '@/lib/types';
import { Link } from 'react-router-dom';

export default function TopDates() {
  const [days, setDays] = useState<RaceDay[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAllDays()
      .then((ds) => {
        // 重複除去（dateユニーク）と空meetingsガードはloader側でも実施済みだが、念のためUI側でも最小限ガード
        const seen = new Set<string>();
        const uniq = ds.filter((d) => {
          if (!d || typeof d.date !== 'string') return false;
          if (seen.has(d.date)) return false;
          seen.add(d.date);
          return Array.isArray(d.meetings) && d.meetings.length > 0;
        });
        setDays(uniq);
        setError(null);
      })
      .catch(() => setError('データの読み込みに失敗しました。'));
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">出馬表（4日分）</h1>
      {error && (
        <div className="text-red-600 text-sm" role="alert">
          {error}
        </div>
      )}
      {days.length === 0 ? (
        <div className="text-gray-600">表示できる開催がありません。しばらくして再読み込みしてください。</div>
      ) : (
        <ul className="space-y-3">
        {days.map((d) => (
          <li key={d.date} className="border rounded p-3 bg-white">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <Link
                to={`/d/${d.date}`}
                className="text-blue-600 hover:underline text-lg font-semibold"
              >
                {d.date}
              </Link>
              <div className="flex gap-2 text-sm">
                {d.meetings.map((m) => (
                  <Link
                    key={m.track}
                    to={`/d/${d.date}`}
                    className="px-2 py-1 rounded bg-cyan-50 text-cyan-800 hover:bg-cyan-100 border border-cyan-200"
                    title={`${m.track} 1R〜${m.races.length}R`}
                  >
                    {m.kaiji}回 {m.track} {m.nichiji}日目
                  </Link>
                ))}
              </div>
            </div>
          </li>
        ))}
        </ul>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { loadAllDays } from '@/lib/dataLoader';
import type { RaceDay } from '@/lib/types';
import { Link } from 'react-router-dom';

export default function TopDates() {
  const [days, setDays] = useState<RaceDay[]>([]);

  useEffect(() => {
    loadAllDays().then(setDays);
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">出馬表（4日分）</h1>
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
    </div>
  );
}

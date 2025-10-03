import { useEffect, useState } from 'react';
import { loadLatestReco, type DayReco } from '@/lib/dataLoader';
import { Link } from 'react-router-dom';

export default function LatestReco() {
  const [reco, setReco] = useState<DayReco[]>([]);

  useEffect(() => {
    loadLatestReco().then(setReco);
  }, []);

  if (!reco.length) return <div>推奨が見つかりません。</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">最新4日分の推奨</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {reco.map((d) => (
          <div key={d.date} className="bg-white rounded shadow p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-bold">{d.date}</h3>
              <Link className="text-blue-600 hover:underline text-sm" to={`/d/${d.date}`}>当日の出馬表へ</Link>
            </div>
            <div className="text-sm text-gray-600 mb-2">レース数: {d.races?.length ?? 0}</div>
            <div className="space-y-1 max-h-64 overflow-auto pr-1">
              {d.races.slice(0, 10).map((r) => (
                <div key={`${r.track}-${r.no}`} className="flex items-center justify-between">
                  <div className="truncate">
                    <span className="inline-block w-10 text-gray-500">{r.track}</span>
                    <span className="inline-block w-8">R{r.no}</span>
                  </div>
                  <div className="text-xs text-gray-700">
                    {r.win?.length ? (<span className="mr-2">単勝: {r.win.join(', ')}</span>) : null}
                    {r.place?.length ? (<span className="mr-2">複勝: {r.place.join(', ')}</span>) : null}
                    {r.quinella_box?.length ? (<span>馬連: {r.quinella_box.join('-')}</span>) : null}
                  </div>
                </div>
              ))}
              {d.races.length > 10 ? <div className="text-xs text-gray-500">…他 {d.races.length - 10} レース</div> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}



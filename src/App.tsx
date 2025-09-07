import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import TopDates from '@/components/TopDates';
import DayGrid from '@/components/DayGrid';
import RaceTable from '@/components/RaceTable';

export default function App({ basename }: { basename: string }) {
  return (
    <BrowserRouter basename={basename}>
      <div className="max-w-6xl mx-auto p-4 space-y-6">
        <header className="flex items-center justify-between">
          <Link to="/" className="text-2xl font-bold">競馬 出馬表</Link>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<TopDates />} />
            <Route path="/d/:date" element={<DayGrid />} />
            <Route path="/r/:date/:track/:no" element={<RaceTable />} />
          </Routes>
        </main>
        <footer className="text-xs text-gray-500">
          公開範囲: 最新4日分 / データは public/data/*.json を参照
        </footer>
      </div>
    </BrowserRouter>
  );
}


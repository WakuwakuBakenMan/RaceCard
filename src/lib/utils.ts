// 枠番(1-8)に対応したTailwindクラスを返す
export function frameBgClass(draw: number): string {
  const map: Record<number, string> = {
    1: 'bg-white text-black',
    2: 'bg-black text-white',
    3: 'bg-red-500 text-white',
    4: 'bg-blue-500 text-white',
    5: 'bg-yellow-400 text-black',
    6: 'bg-green-500 text-white',
    7: 'bg-orange-500 text-white',
    8: 'bg-pink-500 text-black',
  };
  return map[draw] || 'bg-gray-200 text-black';
}

export function formatRaceHeader(args: {
  track: string;
  no: number;
  pace_score?: number;
  pace_mark?: string;
  distance_m: number;
  ground: string;
  course_note?: string;
  condition?: string;
  start_time?: string;
}): string {
  const parts: string[] = [];
  parts.push(`${args.track} ${args.no}R`);
  if (typeof args.pace_score === 'number' || args.pace_mark) {
    const score = args.pace_score ?? 0;
    const mark = args.pace_mark ?? '';
    parts.push(`／展開カウント ${score}${mark}`);
  }
  const right = [
    args.course_note,
    `${args.distance_m}m`,
    args.ground,
    args.condition,
    args.start_time ? `発走 ${args.start_time}` : undefined,
  ].filter(Boolean);
  if (right.length) parts.push(`／${right.join('・')}`);
  return parts.join('');
}

import { frameBgClass } from '@/lib/utils';

type Props = { draw: number };

export default function FrameBadge({ draw }: Props) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-semibold ${frameBgClass(
        draw
      )}`}
      title={`枠 ${draw}`}
    >
      {draw}
    </span>
  );
}


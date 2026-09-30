import { cn } from '@/lib/cn';

/** 6 × 9 pixel glyphs for the wordmark in the Figma frames. `#` is a filled cell. */
const GLYPHS: Record<string, string[]> = {
  O: ['######', '######', '##..##', '##..##', '##..##', '##..##', '##..##', '######', '######'],
  N: ['##..##', '###.##', '######', '######', '##.###', '##..##', '##..##', '##..##', '##..##'],
  B: ['#####.', '######', '##..##', '#####.', '#####.', '##..##', '##..##', '######', '#####.'],
};

const WORD = 'ONB';

/** The pixel wordmark, drawn as SVG so it is crisp at any size and follows the text colour. */
export function Logo({ className }: { className?: string }) {
  const cells: { x: number; y: number }[] = [];
  [...WORD].forEach((ch, i) =>
    GLYPHS[ch]!.forEach((row, y) => [...row].forEach((c, x) => c === '#' && cells.push({ x: i * 7 + x, y }))),
  );
  return (
    <svg
      viewBox={`0 0 ${WORD.length * 7 - 1} 9`}
      className={cn('h-7 w-auto text-ink', className)}
      role="img"
      aria-label="ReachInbox"
      shapeRendering="crispEdges"
    >
      {cells.map(({ x, y }) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="currentColor" />
      ))}
    </svg>
  );
}

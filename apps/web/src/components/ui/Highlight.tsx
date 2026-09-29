import { HL_CLOSE, HL_OPEN } from '@ri/shared';

const SPLIT = new RegExp(`(${HL_OPEN}[^${HL_CLOSE}]*${HL_CLOSE})`, 'g');

/**
 * Renders search highlights. The server marks matches with control characters (never HTML), and
 * everything is rendered as text nodes — so user content can't inject markup.
 */
export function Highlight({ text }: { text: string }) {
  return (
    <>
      {text.split(SPLIT).map((part, i) =>
        part.startsWith(HL_OPEN) ? (
          <mark key={i} className="rounded-sm bg-amber-200/70 px-0.5 text-ink">
            {part.slice(1, -1)}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

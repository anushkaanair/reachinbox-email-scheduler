import { CheckCircle2, ShieldAlert, Wand2 } from 'lucide-react';
import { useDeferredValue, useMemo } from 'react';
import { checkSpam, type SpamField, type SpamGrade, type SpamIssue, type StatusTone } from '@ri/shared';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';

const GRADE: Record<SpamGrade, { label: string; tone: StatusTone; bar: string; text: string }> = {
  great: { label: 'Great', tone: 'success', bar: 'bg-st-sent', text: 'Reads like a personal email.' },
  good: { label: 'Good', tone: 'info', bar: 'bg-info', text: 'Mostly fine — a couple of small things to tidy.' },
  risky: { label: 'Risky', tone: 'warning', bar: 'bg-st-deferred', text: 'Several spam signals. Worth fixing before you send.' },
  poor: { label: 'Likely spam', tone: 'danger', bar: 'bg-st-failed', text: 'High chance of landing in spam. Fix the red items first.' },
};

const SEVERITY: Record<SpamIssue['severity'], { tone: StatusTone; label: string }> = {
  high: { tone: 'danger', label: 'High' },
  medium: { tone: 'warning', label: 'Medium' },
  low: { tone: 'neutral', label: 'Low' },
};

/**
 * Live spam check of the subject and body (all spintax alternatives included). Each issue explains
 * itself, and where there's a plainer phrase, one click swaps it into the text.
 */
export function ContentCheckCard({
  subject,
  body,
  onFix,
}: {
  subject: string;
  body: string;
  onFix: (field: SpamField, match: string, replacement: string) => void;
}) {
  const s = useDeferredValue(subject);
  const b = useDeferredValue(body);
  const report = useMemo(() => checkSpam(s, b), [s, b]);
  const empty = !subject.trim() && !body.trim();
  const g = GRADE[report.grade];

  return (
    <section className="rounded-xl border border-line bg-surface p-5 md:p-6" aria-labelledby="content-check-h">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="content-check-h" className="text-sm font-semibold">Content check</h2>
        {!empty && <Badge tone={g.tone}>{g.label}</Badge>}
      </div>

      {empty ? (
        <p className="text-sm text-muted">Write a subject and body to check them for spam signals.</p>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <span className="text-2xl font-semibold tabular-nums" aria-label={`Score ${report.score} out of 100`}>
              {report.score}
              <span className="text-sm font-normal text-muted">/100</span>
            </span>
            <div className="flex-1">
              <div className="h-2 overflow-hidden rounded-full bg-neutral-soft" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={report.score} aria-label="Content score">
                <div className={cn('h-full rounded-full transition-[width] duration-300', g.bar)} style={{ width: `${Math.max(4, report.score)}%` }} />
              </div>
              <p className="mt-1 text-xs text-muted">
                {g.text} · {report.wordCount} words · {report.linkCount} link{report.linkCount === 1 ? '' : 's'}
              </p>
            </div>
          </div>

          {report.issues.length === 0 ? (
            <p className="mt-4 flex items-center gap-2 text-sm text-brand-700">
              <CheckCircle2 className="size-4" aria-hidden /> No spam signals found.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-line overflow-hidden rounded-lg border border-line" aria-label="Issues">
              {report.issues.map((i) => {
                const canFix = i.match !== undefined && i.replacement !== undefined;
                return (
                  <li key={i.id} className="flex items-start gap-3 px-3 py-2.5">
                    <ShieldAlert className={cn('mt-0.5 size-4 shrink-0', i.severity === 'high' ? 'text-danger' : i.severity === 'medium' ? 'text-warn' : 'text-muted')} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <span className="font-medium">{i.title}</span>
                        <span className="text-xs text-muted">in {i.field}</span>
                        <span className="sr-only">Severity {SEVERITY[i.severity].label}.</span>
                      </p>
                      <p className="text-xs text-muted">{i.detail}</p>
                    </div>
                    {canFix && (
                      <button
                        type="button"
                        onClick={() => onFix(i.field, i.match!, i.replacement!)}
                        className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-xs font-medium text-soft transition-colors hover:border-brand-500 hover:text-brand-700"
                      >
                        <Wand2 className="size-3.5" aria-hidden />
                        {i.replacement ? `Use “${i.replacement}”` : 'Remove'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 text-[11px] text-muted">A heuristic check of wording and formatting, not a guarantee of inbox placement.</p>
        </>
      )}
    </section>
  );
}

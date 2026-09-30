import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { Lead } from '@ri/shared';
import { Button } from '@/components/ui/Button';
import { useTestSend } from '@/hooks/useCompose';
import { cn } from '@/lib/cn';
import { extractTags, leadVars, renderSegments, tagGaps, type Segment } from '@/lib/mergeTags';

const nf = new Intl.NumberFormat();

function Rendered({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.kind === 'text' ? (
          <span key={i}>{s.text}</span>
        ) : (
          <mark
            key={i}
            title={s.kind === 'value' ? `{{${s.tag}}} filled from your file` : `{{${s.tag}}} is empty for this lead`}
            className={cn(
              'rounded px-0.5 font-medium',
              s.kind === 'value' ? 'bg-brand-100 text-brand-700' : 'bg-danger-soft text-danger',
            )}
          >
            {s.text}
          </mark>
        ),
      )}
    </>
  );
}

/**
 * Compose preview: the email exactly as a recipient gets it (merge tags filled in and highlighted),
 * flip through recipients, see which tags would come out blank, and send one real test email.
 */
export function PreviewCard({
  leads,
  subject,
  body,
  senderId,
}: {
  leads: Lead[] | null;
  subject: string;
  body: string;
  senderId: string;
}) {
  const [index, setIndex] = useState(0);
  const test = useTestSend();
  const [lastPreview, setLastPreview] = useState<string | null>(null);
  const total = leads?.length ?? 0;
  useEffect(() => setIndex((i) => Math.min(i, Math.max(0, total - 1))), [total]);

  const lead = leads?.[index] ?? null;
  const vars = useMemo(() => (lead ? leadVars(lead) : { email: 'name@company.com', name: 'Alex' }), [lead]);
  const tags = useMemo(() => extractTags(subject, body), [subject, body]);
  const gaps = useMemo(() => (leads ? tagGaps(leads, tags) : []), [leads, tags]);
  const hasContent = subject.trim() || body.trim();

  const sendTest = () =>
    test.mutate(
      {
        subject: subject.trim(),
        body: body.trim(),
        senderId: senderId || undefined,
        sample: lead ? { email: lead.email, name: lead.name, vars: lead.vars } : undefined,
      },
      {
        onSuccess: (r) => {
          setLastPreview(r.previewUrl);
          toast.success('Test email sent', {
            description: `Delivered to ${r.to} (a sender inbox).`,
            action: r.previewUrl ? { label: 'Open', onClick: () => window.open(r.previewUrl!, '_blank', 'noreferrer') } : undefined,
          });
        },
      },
    );

  return (
    <section className="rounded-xl border border-line bg-surface p-5 md:p-6" aria-labelledby="preview-h">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="preview-h" className="text-sm font-semibold">Preview</h2>
          <p className="text-xs text-muted">
            {lead ? (
              <>
                As <span className="font-medium text-ink">{lead.email}</span> will see it
              </>
            ) : (
              'Sample recipient — upload leads to preview real ones'
            )}
          </p>
        </div>
        {total > 1 && (
          <div className="flex items-center gap-1 text-sm" role="group" aria-label="Choose recipient">
            <Button variant="ghost" size="sm" onClick={() => setIndex((i) => (i - 1 + total) % total)} aria-label="Previous recipient">
              <ChevronLeft className="size-4" />
            </Button>
            <span className="min-w-16 text-center text-xs text-muted tabular-nums" aria-live="polite">
              {nf.format(index + 1)} / {nf.format(total)}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setIndex((i) => (i + 1) % total)} aria-label="Next recipient">
              <ChevronRight className="size-4" />
            </Button>
          </div>
        )}
      </div>

      {gaps.length > 0 && (
        <ul className="mb-4 flex flex-col gap-1.5" aria-label="Merge tag warnings">
          {gaps.map((g) => (
            <li key={g.tag} className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="flex-1">
                {g.unknown ? (
                  <>
                    <code className="font-mono font-semibold">{`{{${g.tag}}}`}</code> isn’t a column in your file — it will be blank for everyone.
                  </>
                ) : (
                  <>
                    <code className="font-mono font-semibold">{`{{${g.tag}}}`}</code> is empty for{' '}
                    <b>{nf.format(g.missing)}</b> of {nf.format(total)} leads.
                  </>
                )}
              </span>
              {!g.unknown && (
                <button type="button" onClick={() => setIndex(g.firstIndex)} className="shrink-0 font-medium underline underline-offset-2 hover:text-warn">
                  Show one
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="overflow-hidden rounded-lg border border-line">
        <div className="border-b border-line bg-canvas/60 px-4 py-2.5 text-sm">
          <span className="text-muted">Subject: </span>
          <span className="font-medium">
            {subject.trim() ? <Rendered segments={renderSegments(subject, vars)} /> : <span className="text-muted">(no subject yet)</span>}
          </span>
        </div>
        <div className="max-h-72 overflow-y-auto px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap" tabIndex={0} aria-label="Email body preview">
          {body.trim() ? <Rendered segments={renderSegments(body, vars)} /> : <span className="text-muted">Start typing the email body to see it here.</span>}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={sendTest} loading={test.isPending} disabled={!hasContent || !subject.trim() || !body.trim()}>
          <Send className="size-4" /> Send test to my inbox
        </Button>
        {lastPreview && (
          <a href={lastPreview} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline">
            Open last test in Ethereal <ExternalLink className="size-3.5" />
          </a>
        )}
        <p className="basis-full text-xs text-muted">
          Sends one real email, with this recipient’s values, to the sender’s own inbox — not to the lead. It respects the sender’s minimum delay.
        </p>
      </div>
    </section>
  );
}

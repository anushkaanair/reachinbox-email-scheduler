import { AlertTriangle, ArrowUpRight, Check, Download, ShieldCheck, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { AssistantBlock, AssistantReply, AssistantTone } from '@ri/shared';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { formatWhen } from '@/lib/format';
import type { ActionState } from './AssistantProvider';

const toneText: Record<AssistantTone, string> = {
  neutral: 'text-ink',
  success: 'text-brand-700',
  warning: 'text-warn',
  danger: 'text-danger',
  info: 'text-info',
};
const toneDot: Record<AssistantTone, string> = {
  neutral: 'bg-faint',
  success: 'bg-st-sent',
  warning: 'bg-st-deferred',
  danger: 'bg-st-failed',
  info: 'bg-info',
};
const toneBar: Record<AssistantTone, string> = { ...toneDot };

function Block({ block, onNavigate }: { block: AssistantBlock; onNavigate?: () => void }) {
  switch (block.type) {
    case 'stats':
      return (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(84px, 1fr))` }}>
          {block.items.map((i) => (
            <div key={i.label} className="rounded-lg border border-line bg-canvas/50 px-3 py-2">
              <dt className="text-xs leading-tight text-muted">{i.label}</dt>
              <dd className={cn('mt-0.5 text-lg font-semibold tabular-nums', toneText[i.tone ?? 'neutral'])}>{i.value}</dd>
              {i.hint && <p className="text-xs text-muted">{i.hint}</p>}
            </div>
          ))}
        </dl>
      );
    case 'table':
      return (
        <div className="overflow-hidden rounded-lg border border-line">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-neutral-soft text-muted">
                <tr>
                  {block.columns.map((c) => (
                    <th key={c} scope="col" className="px-3 py-1.5 font-medium whitespace-nowrap">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {block.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((cell, j) => (
                      <td key={j} className="max-w-56 truncate px-3 py-1.5 align-top" title={cell}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {block.link && (
            <Link to={block.link.to} onClick={onNavigate} className="flex items-center justify-end gap-1 border-t border-line px-3 py-1.5 text-xs font-medium text-brand-700 hover:underline">
              {block.link.label} <ArrowUpRight className="size-3" aria-hidden />
            </Link>
          )}
        </div>
      );
    case 'list':
      return (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {block.items.map((i, idx) => {
            const body = (
              <>
                <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', toneDot[i.tone ?? 'neutral'])} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{i.title}</span>
                  {i.subtitle && <span className="block text-xs text-muted">{i.subtitle}</span>}
                </span>
              </>
            );
            return (
              <li key={idx}>
                {i.to ? (
                  <Link to={i.to} onClick={onNavigate} className="flex gap-2.5 px-3 py-2 hover:bg-neutral-soft">{body}</Link>
                ) : (
                  <div className="flex gap-2.5 px-3 py-2">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      );
    case 'timeline':
      return (
        <ol className="relative ml-2 border-l border-line">
          {block.items.map((i, idx) => (
            <li key={idx} className="mb-3 ml-4 last:mb-0">
              <span className={cn('absolute -left-[5px] mt-1 size-2.5 rounded-full ring-4 ring-[var(--c-surface-solid)]', toneDot[i.tone ?? 'neutral'])} aria-hidden />
              <p className="text-sm leading-tight">{i.label}</p>
              <p className="text-xs text-muted">
                {formatWhen(i.at)}
                {i.detail && <> · {i.detail}</>}
              </p>
            </li>
          ))}
        </ol>
      );
    case 'bars':
      return (
        <ul className="flex flex-col gap-2.5">
          {block.items.map((i) => {
            const pct = Math.min(100, (i.value / Math.max(1, i.max)) * 100);
            return (
              <li key={i.label}>
                <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate">{i.label}</span>
                  <span className="shrink-0 text-muted tabular-nums">{i.hint ?? `${i.value}/${i.max}`}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-neutral-soft" role="progressbar" aria-valuemin={0} aria-valuemax={i.max} aria-valuenow={i.value} aria-label={i.label}>
                  <div className={cn('h-full rounded-full transition-[width] duration-500', toneBar[i.tone ?? 'success'])} style={{ width: `${Math.max(pct, i.value > 0 ? 3 : 0)}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      );
  }
}

/** The confirm-first card: every change the assistant proposes waits here for an explicit yes. */
function ConfirmCard({ reply, action, onConfirm, onDecline }: { reply: AssistantReply; action: ActionState; onConfirm: () => void; onDecline: () => void }) {
  const p = reply.pending!;
  const busy = action === 'busy';
  const done = action !== 'idle' && action !== 'busy';
  const status = { confirmed: 'Done', declined: 'Cancelled — nothing changed', expired: 'Expired' } as const;
  return (
    <div className={cn('rounded-xl border p-3', p.danger ? 'border-danger-line bg-danger-soft' : 'border-accent/40 bg-accent-soft')} role="group" aria-label="Confirm action">
      <div className="flex items-start gap-2.5">
        <span className={cn('mt-0.5 grid size-6 shrink-0 place-items-center rounded-full', p.danger ? 'bg-danger-solid text-on-danger' : 'bg-accent text-on-accent')}>
          {p.danger ? <AlertTriangle className="size-3.5" aria-hidden /> : <ShieldCheck className="size-3.5" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{p.title}</p>
          <p className="mt-0.5 text-xs text-soft">{p.description}</p>
        </div>
      </div>
      {done ? (
        <p className={cn('mt-3 flex items-center gap-1.5 text-xs font-medium', action === 'confirmed' ? 'text-brand-700' : 'text-muted')}>
          {action === 'confirmed' ? <Check className="size-3.5" aria-hidden /> : <X className="size-3.5" aria-hidden />}
          {status[action as keyof typeof status]}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant={p.danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>{p.confirmLabel}</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onDecline}>Cancel</Button>
          <span className="ml-auto text-[11px] text-muted">Nothing changes until you confirm</span>
        </div>
      )}
    </div>
  );
}

const chip = 'rounded-full border border-line bg-surface-solid/60 px-2.5 py-1 text-xs text-soft transition-colors hover:border-accent hover:text-accent focus-visible:border-accent';

/** One assistant answer: text, blocks, the confirm card, links, and clickable follow-ups. */
export function ReplyView({
  reply,
  action = 'idle',
  onSuggest,
  onConfirm,
  onDecline,
  onNavigate,
  showSuggestions = true,
}: {
  reply: AssistantReply;
  action?: ActionState;
  onSuggest: (text: string) => void;
  onConfirm?: () => void;
  onDecline?: () => void;
  onNavigate?: () => void;
  showSuggestions?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {/* A proposal's card already says everything the text would, so don't repeat it. */}
      {!reply.pending && <p className="text-sm leading-relaxed whitespace-pre-wrap">{reply.text}</p>}
      {reply.blocks.map((b, i) => (
        <Block key={i} block={b} onNavigate={onNavigate} />
      ))}
      {reply.pending && onConfirm && onDecline && <ConfirmCard reply={reply} action={action} onConfirm={onConfirm} onDecline={onDecline} />}
      {(reply.navigate || reply.download) && (
        <div className="flex flex-wrap gap-2">
          {reply.navigate &&
            (reply.navigate.external ? (
              <a href={reply.navigate.to} target="_blank" rel="noreferrer" className={cn(chip, 'inline-flex items-center gap-1')}>
                {reply.navigate.label} <ArrowUpRight className="size-3" aria-hidden />
              </a>
            ) : (
              <Link to={reply.navigate.to} onClick={onNavigate} className={cn(chip, 'inline-flex items-center gap-1')}>
                Open {reply.navigate.label} <ArrowUpRight className="size-3" aria-hidden />
              </Link>
            ))}
          {reply.download && (
            <a href={reply.download.url} download className={cn(chip, 'inline-flex items-center gap-1')}>
              <Download className="size-3" aria-hidden /> {reply.download.label}
            </a>
          )}
        </div>
      )}
      {showSuggestions && reply.suggestions.length > 0 && !reply.pending && (
        <div className="flex flex-wrap gap-1.5" aria-label="Suggested follow-ups">
          {reply.suggestions.map((s) => (
            <button key={s} type="button" onClick={() => onSuggest(s)} className={chip}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

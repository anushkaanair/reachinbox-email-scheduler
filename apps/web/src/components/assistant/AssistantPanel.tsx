import { Eraser, Send, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useStarters, FALLBACK_STARTERS } from '@/hooks/useStarters';
import { cn } from '@/lib/cn';
import { useAssistant } from './AssistantProvider';
import { ReplyView } from './ReplyView';
import { Thinking } from './Thinking';

const MAX_H = 112;

function EmptyState({ onPick }: { onPick: (s: string) => void }) {
  const starters = useStarters(true);
  const items = starters.data?.suggestions ?? FALLBACK_STARTERS;
  return (
    <div className="flex flex-col items-center px-2 pt-8 pb-4 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent">
        <Sparkles className="size-6" aria-hidden />
      </span>
      <h3 className="mt-3 text-base font-semibold">Ask Inbox</h3>
      <p className="mt-1 max-w-64 text-sm text-muted">Questions and commands about your emails, campaigns and senders. It asks before changing anything.</p>
      <div className="mt-5 flex w-full flex-col gap-1.5">
        {items.map((s) => (
          <button key={s} type="button" onClick={() => onPick(s)} className="rounded-xl border border-line bg-surface px-3 py-2 text-left text-sm text-soft transition-colors hover:border-accent hover:text-accent">
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The docked conversation view. On wide screens it sits beside the page and pushes it over; on
 * narrower ones it slides over the right edge (full width on phones).
 */
export function AssistantPanel() {
  const a = useAssistant();
  const open = a.mode === 'panel';
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // Wait a frame so the new turn has been laid out before scrolling to it.
    const raf = requestAnimationFrame(() => end.current?.scrollIntoView({ block: 'end', behavior: reduce ? 'auto' : 'smooth' }));
    return () => cancelAnimationFrame(raf);
  }, [open, a.turns.length, a.busy]);

  if (!open) return null;

  const resize = () => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const v = text.trim();
    if (!v || a.busy) return;
    setText('');
    requestAnimationFrame(resize);
    void a.ask(v);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <aside
      aria-label="Ask Inbox assistant"
      onKeyDown={(e) => e.key === 'Escape' && a.close()}
      className={cn(
        'fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] flex-col border-l border-line bg-surface-solid shadow-2xl',
        'xl:sticky xl:top-0 xl:z-auto xl:h-screen xl:w-[400px] xl:max-w-none xl:shrink-0 xl:shadow-none',
      )}
    >
      <header className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <span className="grid size-8 place-items-center rounded-lg bg-accent-soft text-accent">
          <Sparkles className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold leading-tight">Ask Inbox</h2>
          <p className="text-[11px] text-muted" title="Answers are worked out from your own data. Nothing is sent to an outside AI service.">
            Offline mode · your data stays here
          </p>
        </div>
        {a.turns.length > 0 && (
          <button type="button" onClick={a.clear} aria-label="Clear conversation" title="Clear conversation" className="grid size-8 place-items-center rounded-lg text-muted hover:bg-neutral-soft hover:text-ink">
            <Eraser className="size-4" aria-hidden />
          </button>
        )}
        <button type="button" onClick={a.close} aria-label="Close assistant" className="grid size-8 place-items-center rounded-lg text-muted hover:bg-neutral-soft hover:text-ink">
          <X className="size-4" aria-hidden />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4" role="log" aria-live="polite" aria-label="Conversation">
        {a.turns.length === 0 ? (
          <EmptyState onPick={(s) => void a.ask(s)} />
        ) : (
          <div className="flex flex-col gap-4">
            {a.turns.map((t, i) => {
              const isLast = i === a.turns.length - 1;
              return t.role === 'user' ? (
                <div key={t.id} className="flex justify-end">
                  <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-3 py-2 text-sm text-on-accent">{t.text}</p>
                </div>
              ) : (
                <div key={t.id} className="flex gap-2.5">
                  <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                    <Sparkles className="size-3.5" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <ReplyView
                      reply={t.reply}
                      action={t.action}
                      onSuggest={(s) => void a.ask(s)}
                      onConfirm={() => void a.confirm(t.id)}
                      onDecline={() => void a.decline(t.id)}
                      showSuggestions={isLast}
                    />
                  </div>
                </div>
              );
            })}
            {a.busy && (
              <div className="flex gap-2.5">
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                  <Sparkles className="size-3.5" aria-hidden />
                </span>
                <Thinking />
              </div>
            )}
            <div ref={end} />
          </div>
        )}
      </div>

      <form onSubmit={submit} className="border-t border-line p-3">
        <div className="flex items-end gap-2 rounded-xl border border-line bg-surface px-3 py-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
          <textarea
            ref={field}
            value={text}
            rows={1}
            maxLength={500}
            onChange={(e) => {
              setText(e.target.value);
              resize();
            }}
            onKeyDown={onKey}
            aria-label="Message Ask Inbox"
            placeholder="Ask or tell me what to do…"
            className="max-h-28 min-h-6 flex-1 resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted"
          />
          <button
            type="submit"
            disabled={!text.trim() || a.busy}
            aria-label="Send"
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-on-accent transition-opacity disabled:opacity-40"
          >
            <Send className="size-4" aria-hidden />
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-muted">
          Enter to send · Shift+Enter for a new line · <kbd className="rounded border border-line px-1">⌘K</kbd> quick ask
        </p>
      </form>
    </aside>
  );
}

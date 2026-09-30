import { CornerDownLeft, PanelRightOpen, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useStarters, FALLBACK_STARTERS } from '@/hooks/useStarters';
import { useAssistant } from './AssistantProvider';
import { ReplyView } from './ReplyView';
import { Thinking } from './Thinking';

/**
 * Cmd/Ctrl+K quick ask. Shows only the latest exchange so it stays light; "Open as panel" hands the
 * whole conversation to the side panel. Built on a native <dialog> for focus trapping and Esc.
 */
export function CommandPalette() {
  const a = useAssistant();
  const open = a.mode === 'palette';
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const starters = useStarters(open);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      input.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  // The latest exchange = everything after the last thing the user typed.
  const lastUser = [...a.turns].map((t) => t.role).lastIndexOf('user');
  const exchange = lastUser >= 0 ? a.turns.slice(lastUser) : [];
  const question = exchange[0]?.role === 'user' ? exchange[0].text : null;
  const answers = exchange.slice(1).flatMap((t) => (t.role === 'assistant' ? [t] : []));
  const suggestions = (starters.data?.suggestions ?? FALLBACK_STARTERS).slice(0, 5);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    void a.ask(value);
  };
  const pick = (s: string) => void a.ask(s);

  return (
    <dialog
      ref={dialog}
      onClose={() => open && a.close()}
      onClick={(e) => e.target === dialog.current && a.close()}
      aria-label="Ask Inbox"
      className="m-auto mt-[10vh] w-[min(660px,94vw)] overflow-hidden rounded-2xl border border-line bg-surface-solid p-0 text-ink shadow-2xl"
    >
      <form onSubmit={submit} className="flex items-center gap-3 border-b border-line px-4">
        <Sparkles className="size-5 shrink-0 text-accent" aria-hidden />
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
              a.expand();
            }
          }}
          maxLength={500}
          autoComplete="off"
          spellCheck={false}
          aria-label="Ask about your emails or give a command"
          placeholder="Ask about your emails or give a command"
          className="h-14 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted"
        />
        <kbd className="hidden rounded border border-line px-1.5 py-0.5 text-[11px] text-muted sm:block">esc</kbd>
      </form>

      <div className="max-h-[52vh] overflow-y-auto px-4 py-3" aria-live="polite">
        {question ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted">
              You asked: <span className="text-soft">{question}</span>
            </p>
            {answers.map((t) => (
              <ReplyView
                key={t.id}
                reply={t.reply}
                action={t.action}
                onSuggest={pick}
                onConfirm={() => void a.confirm(t.id)}
                onDecline={() => void a.decline(t.id)}
                onNavigate={a.close}
                showSuggestions={t === answers[answers.length - 1]}
              />
            ))}
            {a.busy && <Thinking />}
          </div>
        ) : (
          <div>
            <p className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Try asking</p>
            <ul className="flex flex-col">
              {suggestions.map((s) => (
                <li key={s}>
                  <button type="button" onClick={() => pick(s)} className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-soft">
                    <Sparkles className="size-4 text-muted group-hover:text-accent" aria-hidden />
                    <span className="flex-1">{s}</span>
                    <CornerDownLeft className="size-3.5 text-muted opacity-0 group-hover:opacity-100" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line bg-neutral-soft/60 px-4 py-2.5 text-xs text-muted">
        <span className="flex items-center gap-1"><kbd className="rounded border border-line px-1">↵</kbd> ask</span>
        <span className="hidden items-center gap-1 sm:flex"><kbd className="rounded border border-line px-1">⌘↵</kbd> ask &amp; open panel</span>
        <span className="ml-auto flex items-center gap-1">
          {a.turns.length > 0 && (
            <button type="button" onClick={a.clear} className="flex items-center gap-1 rounded px-2 py-1 hover:bg-neutral-soft hover:text-ink">
              <Trash2 className="size-3.5" aria-hidden /> Clear
            </button>
          )}
          <button type="button" onClick={a.expand} className="flex items-center gap-1 rounded px-2 py-1 font-medium text-accent hover:bg-accent-soft">
            <PanelRightOpen className="size-3.5" aria-hidden /> Open as panel
          </button>
        </span>
      </footer>
    </dialog>
  );
}

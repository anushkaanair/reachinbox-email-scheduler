import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AssistantContext, AssistantReply } from '@ri/shared';
import { askAssistant, confirmAssistantAction, declineAssistantAction } from '@/api/assistant';
import { ApiError } from '@/api/client';

export type AssistantMode = 'closed' | 'palette' | 'panel';
export type ActionState = 'idle' | 'busy' | 'confirmed' | 'declined' | 'expired';

export type Turn =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; reply: AssistantReply; action: ActionState };

type Ctx = {
  mode: AssistantMode;
  turns: Turn[];
  busy: boolean;
  open: (mode: 'palette' | 'panel') => void;
  close: () => void;
  /** Palette → side panel, keeping the conversation. */
  expand: () => void;
  ask: (text: string) => Promise<void>;
  /** Open the panel and ask straight away ("Ask about this" buttons). */
  askAbout: (text: string, context?: AssistantContext) => void;
  confirm: (turnId: string) => Promise<void>;
  decline: (turnId: string) => Promise<void>;
  clear: () => void;
};

const AssistantCtx = createContext<Ctx | null>(null);
const STORE_KEY = 'ri-assistant-turns';
const MAX_TURNS = 40;

const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));

function load(): Turn[] {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Turn[]).slice(-MAX_TURNS) : [];
  } catch {
    return [];
  }
}

const errorReply = (text: string): AssistantReply => ({ intent: 'error', text, blocks: [], suggestions: ['Give me an overview'], mode: 'offline' });

/** Things that changed on the server — refresh whatever the dashboard is showing. */
const INVALIDATE = [['emails'], ['campaigns'], ['analytics'], ['senders'], ['suppressions'], ['preflight']];

/**
 * Owns the assistant conversation and where it is shown: the Cmd+K palette for a quick ask, or the
 * docked side panel for a longer conversation. The two are views of the same history.
 */
export function AssistantProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<AssistantMode>('closed');
  const [turns, setTurns] = useState<Turn[]>(load);
  const [busy, setBusy] = useState(false);
  const context = useRef<AssistantContext | undefined>(undefined);
  const busyRef = useRef(false);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(turns.slice(-MAX_TURNS)));
    } catch {
      /* storage blocked: the conversation just won't survive a refresh */
    }
  }, [turns]);

  const refreshData = useCallback(() => {
    for (const key of INVALIDATE) void qc.invalidateQueries({ queryKey: key });
  }, [qc]);

  const applyReply = useCallback(
    (reply: AssistantReply) => {
      if (reply.context) context.current = reply.context;
      setTurns((t) => [...t, { id: uid(), role: 'assistant', reply, action: 'idle' }]);
      // An explicit "open analytics" is carried out; other replies only offer the link.
      if (reply.intent === 'navigate' && reply.navigate) {
        if (reply.navigate.external) window.open(reply.navigate.to, '_blank', 'noreferrer');
        else navigate(reply.navigate.to);
      }
      if (reply.intent === 'confirmed') refreshData();
    },
    [navigate, refreshData],
  );

  const ask = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setTurns((t) => [...t, { id: uid(), role: 'user', text: message }]);
      try {
        applyReply(await askAssistant(message, context.current));
      } catch (err) {
        applyReply(
          errorReply(
            err instanceof ApiError && err.status === 429
              ? 'You’re asking quickly — give it a few seconds and try again.'
              : err instanceof ApiError && err.status === 401
                ? 'Your session expired. Sign in again to keep going.'
                : 'Couldn’t reach the assistant. Check that the API is running and try again.',
          ),
        );
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [applyReply],
  );

  const setAction = useCallback((turnId: string, action: ActionState) => {
    setTurns((t) => t.map((x) => (x.id === turnId && x.role === 'assistant' ? { ...x, action } : x)));
  }, []);

  const resolve = useCallback(
    async (turnId: string, run: (id: string) => Promise<AssistantReply>) => {
      const turn = turns.find((t) => t.id === turnId);
      if (!turn || turn.role !== 'assistant' || !turn.reply.pending || turn.action === 'busy') return;
      setAction(turnId, 'busy');
      try {
        const reply = await run(turn.reply.pending.id);
        setAction(turnId, reply.intent === 'confirm_expired' ? 'expired' : run === confirmAssistantAction ? 'confirmed' : 'declined');
        applyReply(reply);
      } catch {
        setAction(turnId, 'idle');
        applyReply(errorReply('That didn’t go through. Nothing was changed — try again.'));
      }
    },
    [applyReply, setAction, turns],
  );

  const confirm = useCallback((id: string) => resolve(id, confirmAssistantAction), [resolve]);
  const decline = useCallback((id: string) => resolve(id, declineAssistantAction), [resolve]);

  const clear = useCallback(() => {
    setTurns([]);
    context.current = undefined;
  }, []);

  const open = useCallback((m: 'palette' | 'panel') => setMode(m), []);
  const close = useCallback(() => setMode('closed'), []);
  const expand = useCallback(() => setMode('panel'), []);

  const askAbout = useCallback(
    (text: string, ctx?: AssistantContext) => {
      if (ctx) context.current = ctx;
      setMode('panel');
      void ask(text);
    },
    [ask],
  );

  // Cmd/Ctrl+K anywhere: toggle the quick palette (or, if the panel is already open, close it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setMode((m) => (m === 'closed' ? 'palette' : 'closed'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const value = useMemo(
    () => ({ mode, turns, busy, open, close, expand, ask, askAbout, confirm, decline, clear }),
    [mode, turns, busy, open, close, expand, ask, askAbout, confirm, decline, clear],
  );
  return <AssistantCtx.Provider value={value}>{children}</AssistantCtx.Provider>;
}

export function useAssistant(): Ctx {
  const v = useContext(AssistantCtx);
  if (!v) throw new Error('useAssistant must be used inside <AssistantProvider>');
  return v;
}

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Underline,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { INDENT_STEP_PX, isHtmlEmpty, MAX_INDENT_STEPS } from '@ri/shared';
import { cn } from '@/lib/cn';
import { sanitizeClient } from '@/lib/sanitizeClient';

export type RichTextHandle = {
  /** Insert plain text at the cursor (merge tags, spintax). */
  insertText: (text: string) => void;
  focus: () => void;
};

type Active = Partial<Record<'bold' | 'italic' | 'underline' | 'strike' | 'ol' | 'ul' | 'left' | 'center' | 'right' | 'quote', boolean>>;

const SIZES = [
  { label: 'Small', value: '2' },
  { label: 'Normal', value: '3' },
  { label: 'Large', value: '5' },
  { label: 'Huge', value: '6' },
] as const;

/** The toolbar from the Figma compose frame. Every button does what it says. */
function ToolButton({ icon: Icon, label, active, onRun }: { icon: LucideIcon; label: string; active?: boolean; onRun: () => void }) {
  return (
    <button
      type="button"
      // Keep the text selection: a click on a button would otherwise move focus out of the editor first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRun}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn('grid size-8 place-items-center rounded-md text-soft transition-colors hover:bg-neutral-strong hover:text-ink', active && 'bg-neutral-strong text-ink')}
    >
      <Icon className="size-[18px]" aria-hidden />
    </button>
  );
}

const CSS_COMMANDS = new Set(['justifyLeft', 'justifyCenter', 'justifyRight', 'fontSize']);

const Divider = () => <span className="mx-1 h-5 w-px bg-line" aria-hidden />;

/** Rich text from a small contenteditable: output is sanitised HTML using only the allowed tags and styles. */
export const RichTextEditor = forwardRef<
  RichTextHandle,
  { value: string; onChange: (html: string) => void; placeholder?: string; invalid?: boolean; describedBy?: string }
>(function RichTextEditor({ value, onChange, placeholder, invalid, describedBy }, ref) {
  const root = useRef<HTMLDivElement>(null);
  const emitted = useRef(value); // the last HTML we reported, so we don't rewrite the DOM (and the caret) while typing
  const [active, setActive] = useState<Active>({});
  const [empty, setEmpty] = useState(isHtmlEmpty(value));

  // Outside changes (a spam-check fix, a loaded draft) replace the content; our own edits never do.
  useLayoutEffect(() => {
    const el = root.current;
    if (el && value !== emitted.current) {
      el.innerHTML = sanitizeClient(value);
      emitted.current = value;
      setEmpty(isHtmlEmpty(value));
    } else if (el && el.innerHTML === '' && value) {
      el.innerHTML = sanitizeClient(value);
    }
  }, [value]);

  const emit = useCallback(() => {
    const el = root.current;
    if (!el) return;
    const html = sanitizeClient(el.innerHTML);
    emitted.current = html;
    setEmpty(isHtmlEmpty(html));
    onChange(html);
  }, [onChange]);

  const refreshActive = useCallback(() => {
    const el = root.current;
    const sel = window.getSelection();
    if (!el || !sel?.anchorNode || !el.contains(sel.anchorNode)) return;
    const q = (c: string) => {
      try {
        return document.queryCommandState(c);
      } catch {
        return false;
      }
    };
    const block = (sel.anchorNode.nodeType === 1 ? (sel.anchorNode as Element) : sel.anchorNode.parentElement)?.closest('blockquote');
    setActive({
      bold: q('bold'),
      italic: q('italic'),
      underline: q('underline'),
      strike: q('strikeThrough'),
      ol: q('insertOrderedList'),
      ul: q('insertUnorderedList'),
      left: q('justifyLeft'),
      center: q('justifyCenter'),
      right: q('justifyRight'),
      quote: Boolean(block && el.contains(block)),
    });
  }, []);

  useEffect(() => {
    document.addEventListener('selectionchange', refreshActive);
    return () => document.removeEventListener('selectionchange', refreshActive);
  }, [refreshActive]);

  const exec = (cmd: string, arg?: string) => {
    if (document.activeElement !== root.current) root.current?.focus();
    // Alignment and size are written as style="…" (which the allowlist understands); bold, italic, underline and
    // strikethrough must stay as <b>, <i>, <u>, <strike>, because a font-weight style would be stripped.
    document.execCommand('styleWithCSS', false, String(CSS_COMMANDS.has(cmd)));
    document.execCommand(cmd, false, arg);
    emit();
    refreshActive();
  };

  /** Indent = a left margin on the block(s) the selection touches, in fixed steps. */
  const indent = (delta: 1 | -1) => {
    const el = root.current;
    const sel = window.getSelection();
    if (!el || !sel?.rangeCount) return;
    el.focus();
    const range = sel.getRangeAt(0);
    const inEditor = (n: Node | null) => Boolean(n && el.contains(n));
    if (!inEditor(range.startContainer)) return;
    // Loose text sits directly in the editor; give it a block so it has something to indent.
    const start = range.startContainer.nodeType === 1 ? (range.startContainer as Element) : range.startContainer.parentElement;
    if (start === el) document.execCommand('formatBlock', false, 'div');
    const blocks = Array.from(el.querySelectorAll('p, div, li, blockquote')).filter(
      (b) => range.intersectsNode(b) && !Array.from(b.querySelectorAll('p, div, li, blockquote')).some((c) => range.intersectsNode(c)),
    ) as HTMLElement[];
    for (const b of blocks) {
      const steps = Math.min(MAX_INDENT_STEPS, Math.max(0, Math.round((parseInt(b.style.marginLeft || '0', 10) || 0) / INDENT_STEP_PX) + delta));
      b.style.marginLeft = steps ? `${steps * INDENT_STEP_PX}px` : '';
      if (!b.getAttribute('style')) b.removeAttribute('style');
    }
    emit();
  };

  const toggleQuote = () => {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    const inQuote = node && (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest('blockquote');
    exec('formatBlock', inQuote ? 'div' : 'blockquote');
  };

  useImperativeHandle(ref, () => ({
    focus: () => root.current?.focus(),
    insertText: (text: string) => {
      root.current?.focus();
      document.execCommand('insertText', false, text);
      emit();
    },
  }));

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={root}
        role="textbox"
        aria-multiline="true"
        aria-label="Body"
        aria-invalid={invalid}
        aria-describedby={describedBy}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        data-empty={empty}
        onInput={emit}
        onBlur={emit}
        onPaste={(e) => {
          // Paste as plain text: formatting from other apps is never wanted, and it keeps the content predictable.
          e.preventDefault();
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
        }}
        className={cn(
          'min-h-80 w-full rounded-2xl bg-neutral-soft p-5 text-[15px] leading-relaxed break-words focus:ring-2 focus:ring-brand-600/40 focus:outline-none',
          'data-[empty=true]:before:pointer-events-none data-[empty=true]:before:text-muted data-[empty=true]:before:content-[attr(data-placeholder)] data-[empty=true]:before:whitespace-pre-line',
          '[&_blockquote]:my-2 [&_blockquote]:border-l-4 [&_blockquote]:border-line [&_blockquote]:pl-4 [&_blockquote]:text-soft [&_ol]:ml-6 [&_ol]:list-decimal [&_ul]:ml-6 [&_ul]:list-disc [&_a]:text-brand-700 [&_a]:underline',
          invalid && 'ring-2 ring-danger-solid/50',
        )}
      />
      <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 rounded-full bg-neutral-soft px-3 py-1.5">
        <ToolButton icon={Undo2} label="Undo" onRun={() => exec('undo')} />
        <ToolButton icon={Redo2} label="Redo" onRun={() => exec('redo')} />
        <Divider />
        <label className="sr-only" htmlFor="rte-size">Text size</label>
        <select
          id="rte-size"
          defaultValue="3"
          onChange={(e) => {
            exec('fontSize', e.target.value);
            e.target.value = '3';
          }}
          className="h-8 rounded-md bg-transparent px-1 text-sm text-soft hover:bg-neutral-strong focus:outline-none"
        >
          {SIZES.map((s) => (
            <option key={s.value} value={s.value}>{s.label === 'Normal' ? 'Size' : s.label}</option>
          ))}
        </select>
        <Divider />
        <ToolButton icon={Bold} label="Bold" active={active.bold} onRun={() => exec('bold')} />
        <ToolButton icon={Italic} label="Italic" active={active.italic} onRun={() => exec('italic')} />
        <ToolButton icon={Underline} label="Underline" active={active.underline} onRun={() => exec('underline')} />
        <ToolButton icon={Strikethrough} label="Strikethrough" active={active.strike} onRun={() => exec('strikeThrough')} />
        <Divider />
        <ToolButton icon={AlignLeft} label="Align left" active={active.left} onRun={() => exec('justifyLeft')} />
        <ToolButton icon={AlignCenter} label="Align center" active={active.center} onRun={() => exec('justifyCenter')} />
        <ToolButton icon={AlignRight} label="Align right" active={active.right} onRun={() => exec('justifyRight')} />
        <Divider />
        <ToolButton icon={ListOrdered} label="Numbered list" active={active.ol} onRun={() => exec('insertOrderedList')} />
        <ToolButton icon={List} label="Bulleted list" active={active.ul} onRun={() => exec('insertUnorderedList')} />
        <ToolButton icon={IndentDecrease} label="Decrease indent" onRun={() => indent(-1)} />
        <ToolButton icon={IndentIncrease} label="Increase indent" onRun={() => indent(1)} />
        <ToolButton icon={Quote} label="Quote" active={active.quote} onRun={toggleQuote} />
      </div>
    </div>
  );
});

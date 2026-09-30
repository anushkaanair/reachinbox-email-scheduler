import { FileUp } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Click-or-drop single-file picker. Validation of the file itself is left to the caller. */
export function Dropzone({
  accept,
  onFile,
  disabled,
  title = 'Upload a file',
  hint,
  invalid,
}: {
  accept: string[];
  onFile: (file: File) => void;
  disabled?: boolean;
  title?: string;
  hint?: ReactNode;
  invalid?: boolean;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (f) onFile(f);
    if (input.current) input.current.value = ''; // allow re-selecting the same file
  };

  return (
    <label
      htmlFor={id}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) pick(e.dataTransfer.files);
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors',
        over ? 'border-brand-500 bg-brand-50' : 'border-line bg-canvas/50 hover:border-brand-500/60',
        invalid && 'border-danger',
        disabled && 'pointer-events-none opacity-60',
      )}
    >
      <span className="grid size-10 place-items-center rounded-full bg-brand-100 text-brand-700">
        <FileUp className="size-5" aria-hidden />
      </span>
      <span className="text-sm font-medium text-ink">
        {title} <span className="text-brand-600">or drag & drop</span>
      </span>
      {hint && <span className="text-xs text-muted">{hint}</span>}
      <input
        ref={input}
        id={id}
        type="file"
        accept={accept.join(',')}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => pick(e.target.files)}
      />
    </label>
  );
}

import { AlertTriangle, CheckCircle2, FileText, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dropzone } from '@/components/ui/Dropzone';
import { ACCEPTED_EXTENSIONS, MAX_UPLOAD_BYTES, parseLeads, type ParsedLeads } from '@/lib/csv';

export type UploadedLeads = ParsedLeads & { fileName: string };

const PREVIEW = 6;
const nf = new Intl.NumberFormat();

/** "To" field: upload a CSV/TXT, parse it in the browser and show exactly what was detected. */
export function LeadsUpload({
  value,
  onChange,
  error,
}: {
  value: UploadedLeads | null;
  onChange: (v: UploadedLeads | null) => void;
  error?: string;
}) {
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const handleFile = async (file: File) => {
    setReadError(null);
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(ext)) return setReadError('Please upload a .csv or .txt file.');
    if (file.size > MAX_UPLOAD_BYTES) return setReadError('File is larger than 5 MB.');
    setReading(true);
    try {
      const parsed = parseLeads(await file.text());
      if (parsed.leads.length === 0) {
        setReadError(`No valid email addresses found in ${file.name}.`);
        onChange(null);
      } else onChange({ ...parsed, fileName: file.name });
    } catch {
      setReadError('Could not read that file.');
    } finally {
      setReading(false);
    }
  };

  const message = readError ?? error;

  if (!value) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink">To</span>
        <Dropzone
          accept={ACCEPTED_EXTENSIONS}
          onFile={handleFile}
          disabled={reading}
          invalid={Boolean(message)}
          title="Upload lead list"
          hint="CSV with an “email” column (other columns become {{merge_tags}}) or a plain .txt list · max 5 MB"
        />
        {message && <p className="text-xs text-red-600">{message}</p>}
      </div>
    );
  }

  const { leads, invalid, duplicates, truncated, fileName } = value;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">To</span>
      <div className="rounded-xl border border-line bg-canvas/40 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
              <FileText className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{fileName}</p>
              <p className="flex items-center gap-1.5 text-sm font-semibold text-brand-700" aria-live="polite">
                <CheckCircle2 className="size-4" aria-hidden />
                {nf.format(leads.length)} email{leads.length === 1 ? '' : 's'} detected
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onChange(null)} aria-label="Remove file">
            <X className="size-4" />
          </Button>
        </div>

        {(invalid.length > 0 || duplicates > 0 || truncated) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {invalid.length > 0 && <Badge tone="danger">{nf.format(invalid.length)} invalid skipped</Badge>}
            {duplicates > 0 && <Badge tone="warning">{nf.format(duplicates)} duplicate{duplicates === 1 ? '' : 's'} removed</Badge>}
            {truncated && (
              <Badge tone="warning">
                <AlertTriangle className="size-3" /> Limited to first 10,000
              </Badge>
            )}
          </div>
        )}

        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Recipients preview">
          {leads.slice(0, PREVIEW).map((l) => (
            <li key={l.email} className="rounded-md border border-line bg-surface px-2 py-0.5 text-xs text-ink">
              {l.email}
            </li>
          ))}
          {leads.length > PREVIEW && (
            <li className="px-1 py-0.5 text-xs text-muted">+{nf.format(leads.length - PREVIEW)} more</li>
          )}
        </ul>

        {invalid.length > 0 && (
          <details className="mt-3 text-xs text-muted">
            <summary className="cursor-pointer select-none">Show invalid entries</summary>
            <p className="mt-1 break-all">{invalid.slice(0, 50).join(', ')}{invalid.length > 50 ? ' …' : ''}</p>
          </details>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

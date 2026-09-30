import { CheckCircle2, Download, TriangleAlert, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { IMPORT_FIELDS, suggestMapping, type ImportFieldKey, type ImportReport } from '@ri/shared';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Dropzone } from '@/components/ui/Dropzone';
import { Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useImportAccounts } from '@/hooks/useSenderHealth';
import { applyMapping, missingRequired, parseAccountsCsv, SAMPLE_CSV, type ParsedAccountsCsv } from '@/lib/accounts';

const MAX_ROWS = 200;

function downloadSample() {
  const url = URL.createObjectURL(new Blob([SAMPLE_CSV], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'email-accounts-sample.csv' });
  a.click();
  URL.revokeObjectURL(url);
}

/** Upload → map columns → import, with a per-row report. Columns we don't use (IMAP, tracking domain…) are ignored. */
export function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [csv, setCsv] = useState<ParsedAccountsCsv | null>(null);
  const [mapping, setMapping] = useState<Record<string, ImportFieldKey | null>>({});
  const [verify, setVerify] = useState(true);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useImportAccounts();

  const reset = () => {
    setCsv(null);
    setMapping({});
    setReport(null);
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const onFile = async (file: File) => {
    setError(null);
    if (file.size > 1_000_000) return setError('That file is too large (limit 1 MB).');
    const parsed = parseAccountsCsv(await file.text());
    if (parsed.headers.length === 0 || parsed.rows.length === 0) return setError('No rows found. The first row must be a header.');
    if (parsed.rows.length > MAX_ROWS) return setError(`Up to ${MAX_ROWS} accounts per upload (this file has ${parsed.rows.length}).`);
    setCsv(parsed);
    setMapping(suggestMapping(parsed.headers));
  };

  const missing = useMemo(() => missingRequired(mapping), [mapping]);
  const used = new Set(Object.values(mapping).filter(Boolean));

  const submit = () => {
    if (!csv) return;
    setError(null);
    run.mutate({ rows: applyMapping(csv.rows, mapping), verify }, { onSuccess: setReport, onError: (e) => setError(e.message) });
  };

  return (
    <Modal open={open} onClose={close} title="Upload email accounts" className="max-w-3xl">
      {report ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            {[
              ['Connected', report.created, 'text-brand-700'],
              ['Skipped', report.skipped, 'text-warn'],
              ['Failed', report.failed, 'text-danger'],
            ].map(([k, v, c]) => (
              <div key={k as string} className="rounded-xl border border-line p-3">
                <p className={`text-2xl font-semibold tabular-nums ${c}`}>{v}</p>
                <p className="text-xs text-muted">{k}</p>
              </div>
            ))}
          </div>
          <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-xl border border-line text-sm" aria-label="Row results">
            {report.results.map((r) => (
              <li key={r.row} className="flex items-start gap-2 px-3 py-2">
                {r.status === 'created' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-st-sent" aria-hidden /> : r.status === 'skipped' ? <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />}
                <span className="min-w-0 flex-1 break-words">
                  <span className="text-muted">Row {r.row}</span> · {r.email || '(no email)'}
                  {r.message && <span className="block text-xs text-muted">{r.message}</span>}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={reset}>Upload another file</Button>
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      ) : !csv ? (
        <div className="flex flex-col gap-4">
          <Dropzone accept={['.csv', 'text/csv']} onFile={(f) => void onFile(f)} title="Choose a CSV file" hint={`One account per row · up to ${MAX_ROWS} · 1 MB`} invalid={Boolean(error)} />
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>Needs: {IMPORT_FIELDS.filter((f) => f.required).map((f) => f.label).join(', ')}. SMTP Host is required unless the address is Gmail/Outlook.</span>
            <Button size="sm" variant="ghost" onClick={downloadSample}>
              <Download className="size-4" /> Sample CSV
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-soft">
            <b>{csv.rows.length}</b> account{csv.rows.length === 1 ? '' : 's'} found. Match each column to a field, or leave it as “Ignore”.
          </p>
          <div className="max-h-72 overflow-y-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-canvas text-left text-xs text-muted">
                <tr><th className="px-3 py-2 font-medium">Column in your file</th><th className="px-3 py-2 font-medium">Example</th><th className="px-3 py-2 font-medium">Use as</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {csv.headers.map((h) => (
                  <tr key={h}>
                    <td className="px-3 py-2 font-medium">{h}</td>
                    <td className="max-w-40 truncate px-3 py-2 text-muted">{/pass/i.test(h) ? '••••••' : csv.rows[0]?.[h] || '—'}</td>
                    <td className="px-3 py-2">
                      <Select aria-label={`Field for ${h}`} value={mapping[h] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [h]: (e.target.value || null) as ImportFieldKey | null }))} className="h-9">
                        <option value="">Ignore</option>
                        {IMPORT_FIELDS.map((f) => (
                          <option key={f.key} value={f.key} disabled={used.has(f.key) && mapping[h] !== f.key}>{f.label}{f.required ? ' *' : ''}</option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {missing.length > 0 && <p className="text-sm text-danger">Still to map: {missing.join(', ')}.</p>}
          <Checkbox checked={verify} onChange={(e) => setVerify(e.target.checked)} label="Check each login before saving" hint="Recommended. Accounts whose login fails are reported and not added." />
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={reset}>Choose another file</Button>
            <Button onClick={submit} disabled={missing.length > 0} loading={run.isPending}>
              {run.isPending ? 'Connecting…' : `Connect ${csv.rows.length} account${csv.rows.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

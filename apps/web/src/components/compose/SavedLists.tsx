import { BookmarkPlus, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Lead } from '@ri/shared';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { Modal } from '@/components/ui/Modal';
import { useCreateLeadList, useLeadLists, loadListRecipients } from '@/hooks/useLeadLists';

const nf = new Intl.NumberFormat();

/** "From a list" and "Save as list" next to the recipients: reuse an earlier list, or keep this one for next time. */
export function SavedLists({ leads, onLoad }: { leads: Lead[]; onLoad: (leads: Lead[], listName: string) => void }) {
  const lists = useLeadLists();
  const create = useCreateLeadList();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();

  const pick = async (id: string, listName: string) => {
    try {
      onLoad(await loadListRecipients(id), listName);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Couldn’t load that list');
    }
  };
  const save = () => {
    if (!name.trim()) return setError('Give the list a name');
    create.mutate({ name: name.trim(), leads }, { onSuccess: (l) => { toast.success(`Saved “${l.name}”`, { description: 'Find it under Lead lists; you can check it there before you send.' }); setSaving(false); setName(''); setError(undefined); }, onError: (e) => setError(e.message) });
  };

  return (
    <>
      <Menu
        align="left"
        trigger={({ toggle }) => (
          <button type="button" onClick={toggle} aria-haspopup="menu" className="flex items-center gap-1 text-brand-600 hover:underline"><ListChecks className="size-3.5" aria-hidden /> From a list</button>
        )}
      >
        {lists.isPending ? (
          <p className="px-4 py-2 text-sm text-muted">Loading…</p>
        ) : !lists.data || lists.data.length === 0 ? (
          <p className="px-4 py-2 text-sm text-muted">No saved lists yet.</p>
        ) : (
          lists.data.map((l) => (
            <MenuItem key={l.id} onSelect={() => void pick(l.id, l.name)}>
              <span className="flex-1 truncate">{l.name}</span>
              <span className="text-xs text-muted">{nf.format(l.total)}</span>
            </MenuItem>
          ))
        )}
      </Menu>
      {leads.length > 0 && (
        <button type="button" onClick={() => setSaving(true)} className="flex items-center gap-1 text-brand-600 hover:underline"><BookmarkPlus className="size-3.5" aria-hidden /> Save as list</button>
      )}
      <Modal open={saving} onClose={() => setSaving(false)} title="Save these recipients as a list" footer={<><Button variant="secondary" onClick={() => setSaving(false)}>Cancel</Button><Button onClick={save} loading={create.isPending}>Save list</Button></>}>
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Conference attendees" maxLength={80} error={error} hint={`${nf.format(leads.length)} address${leads.length === 1 ? '' : 'es'} will be saved.`} />
      </Modal>
    </>
  );
}

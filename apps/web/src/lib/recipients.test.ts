import { describe, expect, it } from 'vitest';
import { EMPTY_RECIPIENTS, addFile, addTyped, recipientsFromLeads, removeLead } from './recipients';

const file = (name: string, text: string, size = text.length) => Object.defineProperty(new File([text], name), 'size', { value: size });

describe('addTyped', () => {
  it('splits on spaces, commas, semicolons and new lines, lowercases and trims wrapping characters', () => {
    const { next, rejected } = addTyped(EMPTY_RECIPIENTS, 'A@x.dev, <b@x.dev>;\n"c@x.dev"  d@x.dev.');
    expect(next.leads.map((l) => l.email)).toEqual(['a@x.dev', 'b@x.dev', 'c@x.dev', 'd@x.dev']);
    expect(rejected).toEqual([]);
  });
  it('refuses invalid entries but keeps the valid ones', () => {
    const { next, rejected } = addTyped(EMPTY_RECIPIENTS, 'ok@x.dev nope @x.dev ok2@x.dev');
    expect(next.leads.map((l) => l.email)).toEqual(['ok@x.dev', 'ok2@x.dev']);
    expect(rejected).toEqual(['nope', '@x.dev']);
  });
  it('ignores addresses already in the list', () => {
    const a = addTyped(EMPTY_RECIPIENTS, 'a@x.dev').next;
    expect(addTyped(a, 'A@x.dev b@x.dev').next.leads.map((l) => l.email)).toEqual(['a@x.dev', 'b@x.dev']);
  });
});

describe('addFile', () => {
  it('merges an upload into typed addresses, dropping duplicates and keeping columns as merge tags', async () => {
    const typed = addTyped(EMPTY_RECIPIENTS, 'ada@x.dev').next;
    const r = await addFile(typed, file('leads.csv', 'Name,Email,Company\nAda,ada@x.dev,Analytical\nBob,bob@x.dev,Acme\nnot-an-email,nope,\n'));
    if ('error' in r) throw new Error(r.error);
    expect(r.next.leads.map((l) => l.email)).toEqual(['ada@x.dev', 'bob@x.dev']);
    expect(r.next.duplicates).toBe(1);
    expect(r.next.tags).toEqual(expect.arrayContaining(['email', 'name', 'company']));
    expect(r.next.fileName).toBe('leads.csv');
  });
  it('rejects the wrong type, big files and files with no addresses', async () => {
    expect(await addFile(EMPTY_RECIPIENTS, file('x.pdf', 'a@x.dev'))).toEqual({ error: 'Please upload a .csv or .txt file.' });
    expect(await addFile(EMPTY_RECIPIENTS, file('x.csv', 'a@x.dev', 6 * 1024 * 1024))).toEqual({ error: 'File is larger than 5 MB.' });
    expect(await addFile(EMPTY_RECIPIENTS, file('x.txt', 'no addresses here'))).toEqual({ error: 'No valid email addresses found in x.txt.' });
  });
});

describe('removeLead', () => {
  it('removes one address', () => {
    const a = addTyped(EMPTY_RECIPIENTS, 'a@x.dev b@x.dev').next;
    expect(removeLead(a, 'a@x.dev').leads.map((l) => l.email)).toEqual(['b@x.dev']);
  });
});

describe('recipientsFromLeads', () => {
  it('restores the list and the merge tags its columns provide', () => {
    const r = recipientsFromLeads([{ email: 'a@x.dev', vars: { company: 'Acme' } }, { email: 'b@x.dev', vars: { role: 'CTO' } }]);
    expect(r.leads).toHaveLength(2);
    expect(r.tags).toEqual(['email', 'name', 'company', 'role']);
    expect(r).toMatchObject({ invalid: [], duplicates: 0, truncated: false, fileName: null });
  });
});

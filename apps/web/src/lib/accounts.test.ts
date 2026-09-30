import { describe, expect, it } from 'vitest';
import { suggestMapping, type SenderDetail } from '@ri/shared';
import { accountSummary, allTags, applyMapping, filterAccounts, missingRequired, parseAccountsCsv } from './accounts';

const acct = (over: Partial<SenderDetail>): SenderDetail =>
  ({ id: 'x', email: 'a@x.dev', displayName: 'A', provider: 'GOOGLE', tags: [], attention: null, dns: null, warmup: { enabled: false, complete: false }, ...over }) as SenderDetail;

describe('filterAccounts', () => {
  const list = [
    acct({ id: '1', email: 'ann@g.dev', provider: 'GOOGLE', tags: ['sales'], attention: 'error' }),
    acct({ id: '2', email: 'bob@m.dev', provider: 'OUTLOOK', tags: ['sales', 'eu'], warmup: { enabled: true, complete: false } as SenderDetail['warmup'] }),
    acct({ id: '3', email: 'cy@c.dev', provider: 'CUSTOM', displayName: 'Cy Smith' }),
  ];
  const ids = (r: SenderDetail[]) => r.map((s) => s.id);

  it('returns everything with no filters', () => expect(ids(filterAccounts(list, new Set(), ''))).toEqual(['1', '2', '3']));
  it('combines filters with AND', () => {
    expect(ids(filterAccounts(list, new Set(['errors']), ''))).toEqual(['1']);
    expect(ids(filterAccounts(list, new Set(['warming', 'outlook']), ''))).toEqual(['2']);
    expect(ids(filterAccounts(list, new Set(['errors', 'outlook']), ''))).toEqual([]);
  });
  it('searches email, name and tags; tag filters narrow', () => {
    expect(ids(filterAccounts(list, new Set(), 'smith'))).toEqual(['3']);
    expect(ids(filterAccounts(list, new Set(), 'EU'))).toEqual(['2']);
    expect(ids(filterAccounts(list, new Set(), '', new Set(['sales', 'eu'])))).toEqual(['2']);
  });
  it('summarises and lists tags', () => {
    expect(accountSummary(list)).toEqual({ total: 3, attention: 1, warming: 1 });
    expect(allTags(list)).toEqual(['eu', 'sales']);
  });
});

describe('accounts CSV', () => {
  const text = '﻿Email,First Name,SMTP Password,IMAP Host,Notes\r\na@x.dev,Ann,pw1,imap.x.dev,hi\r\n\r\nb@x.dev,Bob,pw2,imap.x.dev,\r\n';
  it('parses headers and rows, ignoring blank lines and the BOM', () => {
    const p = parseAccountsCsv(text);
    expect(p.headers).toEqual(['Email', 'First Name', 'SMTP Password', 'IMAP Host', 'Notes']);
    expect(p.rows).toHaveLength(2);
    expect(p.rows[1]).toMatchObject({ Email: 'b@x.dev', Notes: '' });
  });
  it('maps columns to fields and drops the rest', () => {
    const p = parseAccountsCsv(text);
    const mapping = suggestMapping(p.headers);
    expect(applyMapping(p.rows, mapping)[0]).toEqual({ email: 'a@x.dev', firstName: 'Ann', smtpPass: 'pw1' });
    expect(missingRequired(mapping)).toEqual([]);
    expect(missingRequired({ Email: 'email' })).toEqual(['First Name', 'SMTP Password']);
  });
  it('handles an empty file', () => expect(parseAccountsCsv('')).toEqual({ headers: [], rows: [] }));
});

import { describe, expect, it } from 'vitest';
import { parseLeads } from './csv';

describe('parseLeads', () => {
  it('reads a CSV with an email header, name column and extra columns as merge tags', () => {
    const r = parseLeads('Name,Email,Company Name\nAda,ADA@x.dev,Analytical\nBob,bob@x.dev,\n');
    expect(r.mode).toBe('columns');
    expect(r.leads).toEqual([
      { email: 'ada@x.dev', name: 'Ada', vars: { company_name: 'Analytical' } },
      { email: 'bob@x.dev', name: 'Bob' },
    ]);
    expect(r.tags).toEqual(['email', 'name', 'company_name']);
  });

  it('reports invalid and duplicate rows', () => {
    const r = parseLeads('email\na@x.dev\nnot-an-email\nA@x.dev\n\n');
    expect(r.leads.map((l) => l.email)).toEqual(['a@x.dev']);
    expect(r.invalid).toEqual(['not-an-email']);
    expect(r.duplicates).toBe(1);
  });

  it('extracts addresses from a plain text list with mixed separators', () => {
    const r = parseLeads('a@x.dev, b@x.dev; <c@x.dev>\n"d@x.dev"\nfoo bar\nbroken@\n');
    expect(r.mode).toBe('scan');
    expect(r.leads.map((l) => l.email)).toEqual(['a@x.dev', 'b@x.dev', 'c@x.dev', 'd@x.dev']);
    expect(r.invalid).toEqual(['broken@']);
  });

  it('scans a headerless CSV', () => {
    const r = parseLeads('Ada,ada@x.dev\nBob,bob@x.dev\n');
    expect(r.leads.map((l) => l.email)).toEqual(['ada@x.dev', 'bob@x.dev']);
  });

  it('handles a UTF-8 BOM and CRLF line endings', () => {
    const r = parseLeads('﻿Email\r\na@x.dev\r\nb@x.dev\r\n');
    expect(r.leads).toHaveLength(2);
  });
});

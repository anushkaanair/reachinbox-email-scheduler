import { describe, expect, it } from 'vitest';
import { extractTags, leadVars, renderSegments, tagGaps } from './mergeTags';

const leads = [
  { email: 'a@x.dev', name: 'Ada', vars: { company: 'Acme' } },
  { email: 'b@x.dev', name: 'Bob', vars: { company: '' } },
  { email: 'c@x.dev' },
];

describe('mergeTags', () => {
  it('extracts unique lower-cased tags from several templates', () => {
    expect(extractTags('Hi {{Name}}', 'At {{ company }}, {{name}} & {{a.b-c}}')).toEqual(['name', 'company', 'a.b-c']);
    expect(extractTags('no tags')).toEqual([]);
  });

  it('builds the value map for a lead (email, name and extra columns)', () => {
    expect(leadVars(leads[0]!)).toEqual({ email: 'a@x.dev', name: 'Ada', company: 'Acme' });
    expect(leadVars({ email: 'z@x.dev', vars: { Company: 'Z' } })).toMatchObject({ company: 'Z' });
  });

  it('reports which tags would render blank, for how many leads, and where to look', () => {
    const gaps = tagGaps(leads, ['name', 'company', 'email']);
    expect(gaps).toEqual([
      { tag: 'name', missing: 1, unknown: false, firstIndex: 2 },
      { tag: 'company', missing: 2, unknown: false, firstIndex: 1 },
    ]);
  });

  it('flags a tag no lead has as unknown', () => {
    expect(tagGaps(leads, ['title'])).toEqual([{ tag: 'title', missing: 3, unknown: true, firstIndex: 0 }]);
    expect(tagGaps([], ['name'])).toEqual([]);
  });

  it('renders highlighted segments: text, filled values, and blanks kept visible', () => {
    const segs = renderSegments('Hi {{name}}, at {{Company}}!', leadVars(leads[1]!));
    expect(segs).toEqual([
      { text: 'Hi ', kind: 'text' },
      { text: 'Bob', kind: 'value', tag: 'name' },
      { text: ', at ', kind: 'text' },
      { text: '{{Company}}', kind: 'missing', tag: 'company' },
      { text: '!', kind: 'text' },
    ]);
    expect(renderSegments('plain', {})).toEqual([{ text: 'plain', kind: 'text' }]);
  });
});

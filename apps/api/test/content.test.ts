import { describe, expect, it } from 'vitest';
import {
  applySpamFix,
  checkSpam,
  CreateCampaignInputSchema,
  flattenSpintax,
  hash32,
  parseSpintax,
  renderTemplate,
  seededRandom,
  spin,
  spintaxError,
  spintaxVariants,
} from '@ri/shared';
import { scheduleTimes } from '../src/modules/campaigns/planning.js';

describe('seeded randomness', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = seededRandom('x');
    const b = seededRandom('x');
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seqA);
    expect(seededRandom('y')()).not.toBe(seqA[0]);
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(hash32('abc')).toBe(hash32('abc'));
  });

  it('is roughly uniform', () => {
    const r = seededRandom('uniform');
    const buckets = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i++) buckets[Math.floor(r() * 4)]!++;
    for (const b of buckets) expect(b).toBeGreaterThan(850);
  });
});

describe('spintax', () => {
  it('picks one option per group, the same one every time for the same recipient', () => {
    const tpl = '{Hi|Hello|Hey} {{name}}, {quick|short} question';
    const a = spin(tpl, 'ada@x.dev');
    expect(spin(tpl, 'ada@x.dev')).toBe(a);
    expect(a).toMatch(/^(Hi|Hello|Hey) \{\{name\}\}, (quick|short) question$/);
  });

  it('spreads recipients across the variants', () => {
    const seen = new Set(Array.from({ length: 60 }, (_, i) => spin('{Hi|Hello|Hey}', `lead${i}@x.dev`)));
    expect(seen).toEqual(new Set(['Hi', 'Hello', 'Hey']));
  });

  it('leaves merge tags alone, even inside an option, and supports nesting and empty options', () => {
    expect(spin('Plain text, {{name}}.', 's')).toBe('Plain text, {{name}}.');
    expect(spin('{Hi {{name}}|Hello {{name}}}', 's')).toMatch(/^(Hi|Hello) \{\{name\}\}$/);
    expect(spin('{a|{b|c}}', 's')).toMatch(/^[abc]$/);
    expect(['', 'really ']).toContain(spin('{|really }', 's'));
  });

  it('never treats a lead’s own data as spintax (spin first, then merge tags)', () => {
    const out = renderTemplate(spin('Hi {{company}}', 's'), { company: '{Acme|Evil}' });
    expect(out).toBe('Hi {Acme|Evil}');
  });

  it('counts variants (product of groups, nested groups add up)', () => {
    expect(spintaxVariants('no spintax')).toBe(1);
    expect(spintaxVariants('{a|b} {c|d|e}')).toBe(6);
    expect(spintaxVariants('{a|{b|c}}')).toBe(3);
    expect(spintaxVariants('{a|b}'.repeat(40))).toBe(1_000_000); // capped
  });

  it('flattens all alternatives for checking', () => {
    expect(flattenSpintax('{FREE|cheap} offer for {{name}}')).toBe('FREE cheap offer for {{name}}');
  });

  it.each([
    ['{Hi|Hello', 'never closed'],
    ['Hello}', 'no matching “{”'],
    ['{name}', 'has only one option'],
    ['Hi {{name', 'merge tag is never closed'],
    ['Hi name}}', '“}}” has no matching'],
  ])('explains malformed spintax: %s', (tpl, msg) => {
    expect(spintaxError(tpl)).toContain(msg);
    expect(parseSpintax(tpl).ok).toBe(false);
    expect(spin(tpl, 's')).toBe(tpl); // unchanged, never half-rendered
  });

  it('valid templates have no error', () => {
    for (const t of ['Hi {{name}}', '{a|b}', 'Braces-free text', '{{a}} {b|c} {{d}}']) expect(spintaxError(t)).toBeNull();
  });

  it('the campaign schema rejects malformed spintax with a clear message', () => {
    const base = { leads: [{ email: 'a@x.dev' }], startAt: new Date().toISOString(), delayBetweenSeconds: 0, hourlyLimit: 5 };
    const bad = CreateCampaignInputSchema.safeParse({ ...base, subject: '{Hi|Hello', body: 'ok' });
    expect(bad.success).toBe(false);
    expect(!bad.success && bad.error.issues[0]?.path).toEqual(['subject']);
    const good = CreateCampaignInputSchema.safeParse({ ...base, subject: '{Hi|Hello} {{name}}', body: 'ok' });
    expect(good.success && good.data.jitterPercent).toBe(0);
    expect(CreateCampaignInputSchema.safeParse({ ...base, subject: 's', body: 'b', jitterPercent: 80 }).success).toBe(false);
  });
});

describe('spam check', () => {
  const clean =
    'Hi {{name}},\n\nI noticed {{company}} is hiring for outbound roles. We help teams like yours book more meetings without adding headcount. Would a short call next week be useful? Happy to share what worked for similar companies.\n\nBest, Anushka';

  it('a plain, personal email scores great', () => {
    const r = checkSpam('Quick question about {{company}}', clean);
    expect(r.grade).toBe('great');
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.issues).toEqual([]);
  });

  it('flags hype words, with replacements, in subject and body', () => {
    const r = checkSpam('FREE trial — act now!!!', 'Click here to get a 100% free guaranteed deal. Limited time. $$$ ' + clean);
    const titles = r.issues.map((i) => i.title);
    expect(titles).toEqual(expect.arrayContaining(['“act now”', '“Click here”', '“100% free”', '“Limited time”', '“$$$”']));
    expect(r.issues.find((i) => i.match === 'Click here')?.replacement).toBeUndefined(); // advice only, no blind swap
    // "free" inside "100% free" is reported once, not twice
    expect(r.issues.filter((i) => i.field === 'body' && /free/i.test(i.match ?? ''))).toHaveLength(1);
    expect(r.grade).toBe('poor');
  });

  it('flags ALL CAPS, repeated punctuation, fake Re:, links, shorteners and lengths', () => {
    const r = checkSpam('Re: LAST CHANCE!!!', 'see https://a.dev https://b.dev http://bit.ly/x https://c.dev ok');
    const t = r.issues.map((i) => i.title).join(' | ');
    expect(t).toContain('ALL CAPS: LAST, CHANCE');
    expect(t).toContain('Repeated punctuation “!!!”');
    expect(t).toContain('Fake “Re:” / “Fwd:”');
    expect(t).toContain('4 links');
    expect(t).toContain('Link shortener (bit.ly');
    expect(t).toContain('Short body');
    expect(r.issues[0]?.severity).toBe('high'); // most severe first
  });

  it('does not flag short acronyms, merge tags or words that merely contain a trigger', () => {
    const r = checkSpam('Our CEO and AI team', `${clean} We are freelancers who built {{FREEFORM}} tooling at cashew.dev.`);
    expect(r.issues.map((i) => i.title).join(' ')).not.toMatch(/CEO|AI|free|cash/i);
  });

  it('checks every spintax alternative', () => {
    const r = checkSpam('{Hello|Act now}', clean);
    expect(r.issues.some((i) => i.match?.toLowerCase() === 'act now')).toBe(true);
  });

  it('fixing every flagged phrase in a row still leaves readable text', () => {
    let subject = 'FREE trial - act now!!!';
    let body = 'Get a 100% free guaranteed demo for {{company}}. Limited time only!';
    for (let k = 0; k < 12; k++) {
      const fix = checkSpam(subject, body).issues.find((i) => i.match !== undefined && i.replacement !== undefined);
      if (!fix) break;
      if (fix.field === 'subject') subject = applySpamFix(subject, fix.match!, fix.replacement!);
      else body = applySpamFix(body, fix.match!, fix.replacement!);
    }
    expect(subject).toBe('No-cost trial!');
    expect(body).toBe('Get a no-cost demo for {{company}}.');
  });

  it('the score degrades gradually', () => {
    const one = checkSpam('Quick question', `${clean} It is amazing.`).score;
    const many = checkSpam('Quick question', `${clean} It is amazing, incredible and revolutionary.`).score;
    expect(one).toBeGreaterThan(many);
    expect(one).toBeGreaterThanOrEqual(90);
  });

  it('applies a fix to the original template, keeping case, merge tags and spintax', () => {
    expect(applySpamFix('A no-risk demo. Act now!', 'Act now', '')).toBe('A no-risk demo.');
    expect(applySpamFix('Get it {free|now}, it is Free', 'free', 'no-cost')).toBe('Get it {no-cost|now}, it is Free');
    expect(applySpamFix('Hi, act now and reply', 'act now', '')).toBe('Hi, and reply');
    expect(applySpamFix('LAST CHANCE', 'LAST', 'Last')).toBe('Last CHANCE');
  });
});

describe('send jitter', () => {
  const start = Date.UTC(2026, 9, 1, 10);

  it('0% keeps exact spacing', () => {
    expect(scheduleTimes(3, start, 60_000, null, 0, 'seed')).toEqual([start, start + 60_000, start + 120_000]);
  });

  it('±25% varies every gap within bounds, keeps order and roughly the same total', () => {
    const t = scheduleTimes(200, start, 60_000, null, 25, 'campaign-a');
    const gaps = t.slice(1).map((x, i) => x - t[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(45_000);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(75_000);
    expect(new Set(gaps).size).toBeGreaterThan(150); // actually varied
    const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    expect(Math.abs(avg - 60_000)).toBeLessThan(3000);
    expect(t[0]).toBe(start); // first email still at the chosen start
  });

  it('is deterministic for the same seed (preview == real schedule)', () => {
    expect(scheduleTimes(10, start, 60_000, null, 30, 's1')).toEqual(scheduleTimes(10, start, 60_000, null, 30, 's1'));
    expect(scheduleTimes(10, start, 60_000, null, 30, 's1')).not.toEqual(scheduleTimes(10, start, 60_000, null, 30, 's2'));
  });

  it('does nothing when there is no delay to vary', () => {
    expect(scheduleTimes(3, start, 0, null, 50, 's')).toEqual([start, start, start]);
  });
});

import { promises as dns } from 'node:dns';
import type { DnsReport } from '@ri/shared';

/** The slice of the DNS resolver we use, so tests can supply records without the network. */
export type Resolver = {
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
};
export const systemResolver: Resolver = { resolveTxt: (n) => dns.resolveTxt(n), resolveMx: (n) => dns.resolveMx(n) };

/** Selectors commonly used by Google Workspace, Microsoft 365 and most ESPs. DKIM can't be discovered without one. */
const DKIM_SELECTORS = ['google', 'selector1', 'selector2', 'default', 'k1', 'k2', 'mail', 's1', 's2', 'dkim'];

const txt = async (r: Resolver, name: string): Promise<string[]> => {
  try {
    return (await r.resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch {
    return [];
  }
};

/** SPF: one record, starts with v=spf1, at most 10 DNS-lookup mechanisms. */
function checkSpf(records: string[]): DnsReport['spf'] {
  const spf = records.filter((r) => /^v=spf1\b/i.test(r));
  if (spf.length === 0) return { status: 'fail', detail: 'No SPF record. Add a TXT record starting with v=spf1.' };
  if (spf.length > 1) return { status: 'fail', detail: 'More than one SPF record. A domain must have exactly one.' };
  const lookups = (spf[0]!.match(/\b(include:|a\b|mx\b|ptr\b|exists:|redirect=)/gi) ?? []).length;
  if (lookups > 10) return { status: 'fail', detail: `SPF needs ${lookups} DNS lookups; the limit is 10.` };
  return { status: 'pass', detail: 'SPF record found.' };
}

function checkDmarc(records: string[]): DnsReport['dmarc'] {
  const d = records.find((r) => /^v=DMARC1\b/i.test(r));
  if (!d) return { status: 'fail', detail: 'No DMARC record at _dmarc.<domain>. Add a TXT record starting with v=DMARC1.' };
  const policy = d.match(/\bp=(\w+)/i)?.[1]?.toLowerCase();
  return { status: 'pass', detail: policy ? `DMARC record found (policy: ${policy}).` : 'DMARC record found.' };
}

export async function checkDomain(domain: string, r: Resolver = systemResolver, now = new Date()): Promise<DnsReport> {
  const d = domain.trim().toLowerCase();
  const [root, dmarcTxt, mx, ...dkim] = await Promise.all([
    txt(r, d),
    txt(r, `_dmarc.${d}`),
    r.resolveMx(d).catch(() => []),
    ...DKIM_SELECTORS.map((s) => txt(r, `${s}._domainkey.${d}`)),
  ]);
  const dkimHit = DKIM_SELECTORS.find((_, i) => dkim[i]!.some((x) => /v=DKIM1|p=/i.test(x)));
  return {
    domain: d,
    checkedAt: now.toISOString(),
    spf: checkSpf(root),
    dmarc: checkDmarc(dmarcTxt),
    mx: mx.length > 0 ? { status: 'pass', detail: `${mx.length} mail server${mx.length > 1 ? 's' : ''} found.` } : { status: 'fail', detail: 'No MX records. The domain can’t receive replies.' },
    dkim: dkimHit
      ? { status: 'pass', detail: `DKIM key found (selector “${dkimHit}”).` }
      : { status: 'unknown', detail: 'No DKIM key found at the common selectors. If your provider uses a custom selector it can’t be detected here.' },
  };
}

import { promises as dns } from 'node:dns';
import type { DomainMail } from '@ri/shared';

/** The slice of the resolver we use, so tests can answer without the network. */
export type MailResolver = {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
};
export const systemMailResolver: MailResolver = { resolveMx: (d) => dns.resolveMx(d), resolve4: (d) => dns.resolve4(d) };

/** "Nothing there" answers (definitive) versus "couldn't find out" (temporary). */
const DEFINITIVE = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms).unref())]);

/**
 * Can this domain receive email? MX records say yes; with none, mail falls back to the domain's own address record
 * (RFC 5321). A "null MX" (a single dot) is the domain explicitly refusing mail (RFC 7505).
 */
export async function domainMail(domain: string, r: MailResolver = systemMailResolver, timeoutMs = 4000): Promise<DomainMail> {
  try {
    const mx = await withTimeout(r.resolveMx(domain), timeoutMs);
    if (mx.length === 1 && (mx[0]!.exchange === '' || mx[0]!.exchange === '.') ) return 'null_mx';
    if (mx.length > 0) return 'accepts';
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (!DEFINITIVE.has(code)) return 'unavailable';
  }
  try {
    const a = await withTimeout(r.resolve4(domain), timeoutMs);
    return a.length > 0 ? 'accepts' : 'none';
  } catch (e) {
    return DEFINITIVE.has((e as { code?: string }).code ?? '') ? 'none' : 'unavailable';
  }
}

/** Look up many domains with bounded parallelism and a deadline; domains not reached in time are left out of the result. */
export async function lookupDomains(domains: string[], r: MailResolver = systemMailResolver, opts: { concurrency?: number; deadlineMs?: number; timeoutMs?: number } = {}): Promise<Map<string, DomainMail>> {
  const out = new Map<string, DomainMail>();
  const queue = [...new Set(domains)];
  const deadline = Date.now() + (opts.deadlineMs ?? 20_000);
  const worker = async () => {
    for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
      if (Date.now() > deadline) return;
      out.set(d, await domainMail(d, r, opts.timeoutMs));
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 12, Math.max(1, queue.length)) }, worker));
  return out;
}

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';

export type SmtpCredentials = { host: string; port: number; user: string; pass: string };

/** Logs in to an SMTP server. Resolves on success, rejects with the server's own message. */
export type SmtpVerifier = (c: SmtpCredentials) => Promise<void>;

/** True for loopback, private, link-local and other non-public IPv4/IPv6 addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Refuses hosts that point inside the network, unless explicitly allowed (dev/test only). */
export async function assertPublicHost(host: string): Promise<void> {
  if (env.ALLOW_PRIVATE_SMTP_HOSTS) return;
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new AppError(422, 'VALIDATION', `Couldn’t find the SMTP host “${host}”. Check the spelling.`);
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw new AppError(422, 'VALIDATION', 'That SMTP host points to a private network address, which isn’t allowed.');
  }
}

/** Real check: open a connection and authenticate. Nothing is sent. */
export const verifySmtp: SmtpVerifier = async ({ host, port, user, pass }) => {
  const t = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await t.verify();
  } finally {
    t.close();
  }
};

/** A short, human message for an SMTP failure (the server's text is already the most useful part). */
export function explainSmtpError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/EAUTH|535|534|invalid login|authentication/i.test(msg)) return `Login was rejected: ${msg.slice(0, 160)}. Check the username and password (Google needs an app password).`;
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'Couldn’t find that SMTP host. Check the host name.';
  if (/ECONNREFUSED|ETIMEDOUT|ESOCKET|timeout/i.test(msg)) return 'Couldn’t reach the SMTP server on that port. Check the host and port, and that SMTP is enabled at the provider.';
  return msg.slice(0, 200);
}

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import nodemailer from 'nodemailer';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';

export type SmtpCredentials = { host: string; port: number; user: string; pass: string };

/** Logs in to an SMTP server. Resolves on success, rejects with the server's own message. */
export type SmtpVerifier = (c: SmtpCredentials) => Promise<void>;

/** Non-public ranges. net.BlockList understands IPv4-mapped IPv6 (::ffff:a00:1 is 10.0.0.1), which hand-rolled checks miss. */
const PRIVATE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

/** True for loopback, private, link-local, multicast and other non-public addresses (anything unparseable counts as unsafe). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  return v === 0 ? true : PRIVATE.check(ip, v === 4 ? 'ipv4' : 'ipv6');
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

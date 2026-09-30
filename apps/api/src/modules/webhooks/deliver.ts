import { createHmac, randomUUID } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { signedString, type WebhookEvent, type WebhookPayload } from '@ri/shared';
import { isPrivateAddress } from '../senders/smtp.js';

/**
 * Sending one webhook. The destination is user-supplied, so:
 *  - the address it resolves to is checked *when the connection is made* (a custom lookup), so there is no gap
 *    between "checked" and "connected" for a DNS answer to change in;
 *  - IP-literal URLs, which skip DNS entirely, are checked up front;
 *  - redirects are never followed (a redirect could point anywhere);
 *  - time and response size are bounded.
 */
export type DeliveryResult = { ok: boolean; status?: number; error?: string };

export const signBody = (secret: string, timestamp: string, rawBody: string) => createHmac('sha256', secret).update(signedString(timestamp, rawBody)).digest('hex');

export const buildPayload = (type: WebhookEvent | 'ping', data: Record<string, unknown>): WebhookPayload => ({ id: randomUUID(), type, createdAt: new Date().toISOString(), data });

const stripBrackets = (h: string) => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h);

/** Throws a readable message if this URL must not be called. Used when saving and again before sending. */
export async function assertSafeUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That isn’t a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Use an http:// or https:// URL.');
  if (url.username || url.password) throw new Error('Put credentials in the signature check, not in the URL.');
  if (allowPrivate) return url;
  const host = stripBrackets(url.hostname);
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('That address is on a private network, which isn’t allowed.');
    return url;
  }
  const addrs = await dns.promises.lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new Error(`Couldn’t find the host “${host}”. Check the spelling.`);
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('That address points to a private network, which isn’t allowed.');
  return url;
}

/** A DNS lookup that refuses private answers, so the address we check is the address we connect to. */
function guardedLookup(allowPrivate: boolean): NonNullable<http.RequestOptions['lookup']> {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      if (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) return callback(Object.assign(new Error('Blocked: private network address'), { code: 'EBLOCKED' }), '', 0);
      if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addresses);
      const first = addresses[0]!;
      return callback(null, first.address, first.family);
    });
  };
}

const MAX_RESPONSE_BYTES = 8 * 1024;

export async function postWebhook(opts: { url: string; secret: string; payload: WebhookPayload; allowPrivate: boolean; timeoutMs?: number }): Promise<DeliveryResult> {
  let url: URL;
  try {
    url = await assertSafeUrl(opts.url, opts.allowPrivate);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid URL' };
  }
  const body = JSON.stringify(opts.payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const lib = url.protocol === 'https:' ? https : http;

  return new Promise<DeliveryResult>((resolve) => {
    let settled = false;
    const done = (r: DeliveryResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const req = lib.request(
      url,
      {
        method: 'POST',
        lookup: guardedLookup(opts.allowPrivate),
        timeout: opts.timeoutMs ?? 10_000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'ReachInbox-Webhooks/1.0',
          'X-ReachInbox-Event': opts.payload.type,
          'X-ReachInbox-Delivery': opts.payload.id,
          'X-ReachInbox-Timestamp': timestamp,
          'X-ReachInbox-Signature': `sha256=${signBody(opts.secret, timestamp, body)}`,
        },
      },
      (res) => {
        let seen = 0;
        res.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > MAX_RESPONSE_BYTES) res.destroy(); // we only need the status
        });
        res.on('error', () => undefined);
        const status = res.statusCode ?? 0;
        res.on('end', () => undefined);
        res.resume();
        if (status >= 200 && status < 300) done({ ok: true, status });
        else if (status >= 300 && status < 400) done({ ok: false, status, error: `Redirected (${status}); redirects are not followed` });
        else done({ ok: false, status, error: `The receiver answered ${status}` });
      },
    );
    req.on('timeout', () => {
      done({ ok: false, error: 'Timed out waiting for the receiver' });
      req.destroy();
    });
    req.on('error', (e: NodeJS.ErrnoException) => done({ ok: false, error: e.code === 'EBLOCKED' ? 'That address points to a private network, which isn’t allowed.' : `Couldn’t connect: ${e.message}`.slice(0, 200) }));
    req.end(body);
  });
}

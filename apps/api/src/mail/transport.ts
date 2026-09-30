import nodemailer, { type Transporter } from 'nodemailer';
import type { Sender } from '@prisma/client';
import { escapeHtml as esc, htmlToText } from '@ri/shared';
import { decrypt } from '../lib/crypto.js';
import type { FileToSend } from './attachments.js';

/** One pooled SMTP connection set per sender, per process. A cache only — never shared state. */
const pool = new Map<string, Transporter>();

function transportFor(sender: Sender): Transporter {
  let t = pool.get(sender.id);
  if (!t) {
    t = nodemailer.createTransport({
      host: sender.smtpHost,
      port: sender.smtpPort,
      secure: sender.smtpPort === 465,
      auth: { user: sender.smtpUser, pass: decrypt(sender.smtpPassEnc) },
      pool: true,
      maxConnections: 2,
    });
    pool.set(sender.id, t);
  }
  return t;
}

export type OutgoingEmail = {
  emailId: string;
  to: string;
  toName: string | null;
  subject: string;
  body: string;
  /** True when `body` is sanitised HTML. */
  bodyIsHtml?: boolean;
  attachments?: FileToSend[];
};

export type SendResult = { messageId: string; previewUrl: string | null };
export type SendFn = (sender: Sender, email: OutgoingEmail) => Promise<SendResult>;

/**
 * Deterministic Message-ID derived from our email id: the same logical email always carries the
 * same Message-ID, so any duplicate would be detectable (and dedupable by receiving servers).
 */
export const messageIdFor = (emailId: string) => `<${emailId}@reachinbox.local>`;

/** The account's signature goes under the message, separated the way mail clients expect. */
export const withSignature = (body: string, signature: string | null) => (signature?.trim() ? `${body}\n\n-- \n${signature.trim()}` : body);

/** The HTML version of a message: the rich body as written, or plain text wrapped so line breaks survive. */
export function htmlFor(email: Pick<OutgoingEmail, 'body' | 'bodyIsHtml'>, signature: string | null): string {
  const sig = signature?.trim() ? `<div style="margin-top:16px;color:#666">-- <br>${esc(signature.trim()).replace(/\n/g, '<br>')}</div>` : '';
  return email.bodyIsHtml
    ? `<div style="font-family:Arial,sans-serif">${email.body}${sig}</div>`
    : `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${esc(email.body)}${sig}</div>`;
}

export const sendViaSmtp: SendFn = async (sender, email) => {
  const plain = email.bodyIsHtml ? htmlToText(email.body) : email.body;
  const info = await transportFor(sender).sendMail({
    from: { name: sender.displayName, address: sender.email },
    ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
    to: email.toName ? { name: email.toName, address: email.to } : email.to,
    subject: email.subject,
    text: withSignature(plain, sender.signature),
    html: htmlFor(email, sender.signature),
    messageId: messageIdFor(email.emailId),
    headers: { 'X-ReachInbox-Email-Id': email.emailId },
    ...(email.attachments?.length ? { attachments: email.attachments } : {}),
  });
  const preview = nodemailer.getTestMessageUrl(info);
  return { messageId: info.messageId, previewUrl: typeof preview === 'string' ? preview : null };
};

export async function closeTransports(): Promise<void> {
  for (const t of pool.values()) t.close();
  pool.clear();
}

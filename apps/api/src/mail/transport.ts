import nodemailer, { type Transporter } from 'nodemailer';
import type { Sender } from '@prisma/client';
import { decrypt } from '../lib/crypto.js';

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
};

export type SendResult = { messageId: string; previewUrl: string | null };
export type SendFn = (sender: Sender, email: OutgoingEmail) => Promise<SendResult>;

/**
 * Deterministic Message-ID derived from our email id: the same logical email always carries the
 * same Message-ID, so any duplicate would be detectable (and dedupable by receiving servers).
 */
export const messageIdFor = (emailId: string) => `<${emailId}@reachinbox.local>`;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const sendViaSmtp: SendFn = async (sender, email) => {
  const info = await transportFor(sender).sendMail({
    from: { name: sender.displayName, address: sender.email },
    to: email.toName ? { name: email.toName, address: email.to } : email.to,
    subject: email.subject,
    text: email.body,
    html: `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${escapeHtml(email.body)}</div>`,
    messageId: messageIdFor(email.emailId),
    headers: { 'X-ReachInbox-Email-Id': email.emailId },
  });
  const preview = nodemailer.getTestMessageUrl(info);
  return { messageId: info.messageId, previewUrl: typeof preview === 'string' ? preview : null };
};

export async function closeTransports(): Promise<void> {
  for (const t of pool.values()) t.close();
  pool.clear();
}

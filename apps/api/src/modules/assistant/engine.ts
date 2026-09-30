import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import {
  isValidEmail,
  type AssistantBlock,
  type AssistantReply,
  type AssistantRequest,
  type CampaignSummary,
  type EmailStatus,
} from '@ri/shared';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { QueueSet } from '../../queues/queues.js';
import type { RateLimiter } from '../../throttle/rateLimiter.js';
import {
  cancelCampaign,
  cancelEmail,
  listCampaigns,
  pauseCampaign,
  resumeCampaign,
  retryEmail,
  retryFailed,
  type ControlDeps,
} from '../campaigns/controls.js';
import type { EmailSearch } from '../search/emailSearch.js';
import { fmtRelative, fmtWhen, nf, plural, rangeBounds, safeZone, shortId, trunc } from './format.js';
import { parseIntent, type CampaignAction, type CampaignTarget, type Intent, type RangeSpec } from './intents.js';

export type AssistantDeps = {
  prisma: PrismaClient;
  redis: Redis;
  queues: QueueSet;
  limiter: RateLimiter;
  config: { perSenderDefault: number };
  search?: EmailSearch;
  /** Status of the backing services; injectable for tests. */
  health?: () => Promise<{ db: boolean; redis: boolean; elasticsearch: boolean }>;
};

type Ctx = {
  userId: string;
  deps: AssistantDeps;
  tz: string;
  campaigns: CampaignSummary[];
  req: AssistantRequest;
};

const PENDING = ['SCHEDULED', 'RATE_LIMITED', 'SENDING'] as const satisfies readonly EmailStatus[];
const WAITING = ['SCHEDULED', 'RATE_LIMITED'] as const satisfies readonly EmailStatus[];
const PENDING_TTL_SEC = 300;
const STARTERS = ['Give me an overview', 'Which sender is closest to its limit?', 'How many emails failed today?', "What's next to send?", 'Show my campaigns'];

const base = (intent: string, text: string, extra: Partial<AssistantReply> = {}): AssistantReply => ({
  intent,
  text,
  blocks: [],
  suggestions: [],
  mode: 'offline',
  ...extra,
});

const stats = (items: { label: string; value: string | number; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; hint?: string }[]): AssistantBlock => ({
  type: 'stats',
  items: items.map((i) => ({ ...i, value: typeof i.value === 'number' ? nf.format(i.value) : i.value })),
});

const quote = (s: string) => `“${trunc(s.replace(/\{\{[^}]*\}\}/g, '…').replace(/\s+/g, ' ').trim(), 60)}”`;

// ── entry points ─────────────────────────────────────────────────────────────

/** Answers a message. Reads run immediately; anything that changes data is only *proposed* here. */
export async function handleMessage(userId: string, req: AssistantRequest, deps: AssistantDeps): Promise<AssistantReply> {
  const tz = safeZone(req.timezone);
  const campaigns = await listCampaigns(userId, deps.prisma);
  const intent = parseIntent(req.message, req.context, campaigns.map((c) => ({ id: c.id, subject: c.subject, status: c.status })));
  const ctx: Ctx = { userId, deps, tz, campaigns, req };

  switch (intent.kind) {
    case 'greeting':
      return base('greeting', 'Hi! I can answer questions about your emails, campaigns and senders, and make changes like pausing a campaign — always after asking you to confirm.', { suggestions: await starters(userId, deps) });
    case 'thanks':
      return base('thanks', 'Anytime.', { suggestions: STARTERS.slice(0, 3) });
    case 'help':
      return help();
    case 'overview':
      return overview(ctx, intent.range);
    case 'count':
      return count(ctx, intent);
    case 'failure_reasons':
      return failureReasons(ctx, intent.range);
    case 'failed_list':
      return failedList(ctx);
    case 'campaigns_list':
      return campaignsList(ctx, intent);
    case 'campaign_report':
      return campaignReport(ctx, intent.target, intent.asks);
    case 'email_lookup':
      return emailLookup(ctx, intent.email);
    case 'search':
      return searchEmails(ctx, intent.term);
    case 'need_term':
      return base('need_term', 'What should I search for? For example: “find emails about northwind”.', { suggestions: ['Find emails about northwind'] });
    case 'navigate':
      return base('navigate', `Opening ${intent.label}.`, { navigate: { to: intent.to, label: intent.label, external: intent.external } });
    case 'export':
      return exportCsv(ctx, intent.scope, intent.target);
    case 'next_sends':
      return nextSends(ctx);
    case 'eta_all':
      return etaAll(ctx);
    case 'rate_limits':
      return rateLimits(ctx);
    case 'sender_usage':
      return senderUsage(ctx);
    case 'slack':
      return slackStatus(ctx);
    case 'spam':
      return base('spam', 'Open Compose: the Content check card scores your subject and body out of 100 as you type, lists each spam signal (hype words, ALL CAPS, !!!, too many links, link shorteners) and offers one-click fixes.', { navigate: { to: '/compose', label: 'Compose' }, suggestions: ['Give me an overview'] });
    case 'health':
      return health(ctx);
    case 'dnc_count':
      return dncOverview(ctx);
    case 'dnc_check':
      return dncCheck(ctx, intent.emails);
    case 'need_emails':
      return base('need_emails', `Which email address${intent.forAction === 'check' ? ' should I check' : intent.forAction === 'add' ? 'es should I add' : 'es should I remove'}? Include them in your message, e.g. “${intent.forAction === 'remove' ? 'unblock' : 'block'} jane@example.com”.`);
    case 'dnc_add':
      return proposeDncAdd(ctx, intent.emails);
    case 'dnc_remove':
      return proposeDncRemove(ctx, intent.emails);
    case 'campaign_action':
      return campaignAction(ctx, intent.action, intent.target);
    case 'retry_all_failed':
      return proposeRetryAll(ctx);
    case 'email_action':
      return emailAction(ctx, intent.action, intent.email);
    default:
      return base('unknown', "I didn't quite get that. I can answer questions about your emails, campaigns, senders and limits, and make changes like pausing a campaign or retrying failures. Try one of these:", {
        suggestions: await starters(userId, deps),
      });
  }
}

/** Starter prompts, tuned to what needs attention right now. */
export async function starters(userId: string, deps: AssistantDeps): Promise<string[]> {
  const [failed, deferred, paused] = await Promise.all([
    deps.prisma.email.count({ where: { userId, status: 'FAILED' } }),
    deps.prisma.email.count({ where: { userId, status: 'RATE_LIMITED' } }),
    deps.prisma.campaign.count({ where: { userId, status: 'PAUSED' } }),
  ]);
  const out: string[] = [];
  if (failed) out.push('Why did emails fail?');
  if (deferred) out.push('When do deferred emails resume?');
  if (paused) out.push('Show paused campaigns');
  return [...out, ...STARTERS].slice(0, 5);
}

// ── read-only answers ────────────────────────────────────────────────────────

function help(): AssistantReply {
  return base('help', 'Here is what I can do. I only ever change something after you press Confirm.', {
    blocks: [
      {
        type: 'list',
        items: [
          { title: 'Ask about your data', subtitle: '“How many emails failed today?”, “What is next to send?”, “Why did emails fail?”' },
          { title: 'Campaigns', subtitle: '“How is the partnership campaign doing?”, “When will it finish?”, “Show paused campaigns”' },
          { title: 'Senders and limits', subtitle: '“Which sender is closest to its limit?”, “Are we being rate limited?”' },
          { title: 'One email', subtitle: '“What happened to jane@example.com?”' },
          { title: 'Take action (asks first)', subtitle: '“Pause the northwind campaign”, “Retry all failed emails”, “Block jane@example.com”' },
          { title: 'Find and export', subtitle: '“Find emails about acme”, “Export failed emails”, “Open analytics”' },
        ],
      },
    ],
    suggestions: STARTERS,
  });
}

async function senderRows(c: Ctx) {
  const senders = await c.deps.prisma.sender.findMany({ where: { isActive: true }, orderBy: { email: 'asc' } });
  return Promise.all(
    senders.map(async (s) => {
      const limit = s.hourlyLimit ?? c.deps.config.perSenderDefault;
      const used = await c.deps.limiter.senderUsage(s.id);
      return { id: s.id, email: s.email, used, limit, ratio: limit > 0 ? used / limit : 0 };
    }),
  );
}

async function statusMap(c: Ctx) {
  const grouped = await c.deps.prisma.email.groupBy({ by: ['status'], where: { userId: c.userId }, _count: { _all: true } });
  const m = (s: EmailStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  return { sent: m('SENT'), failed: m('FAILED'), scheduled: m('SCHEDULED'), deferred: m('RATE_LIMITED'), sending: m('SENDING'), cancelled: m('CANCELLED') };
}

async function overview(c: Ctx, range: RangeSpec): Promise<AssistantReply> {
  const b = rangeBounds(range, c.tz);
  const [m, sentInRange, senders, nextDeferred] = await Promise.all([
    statusMap(c),
    b.since
      ? c.deps.prisma.email.count({ where: { userId: c.userId, status: 'SENT', sentAt: { gte: b.since, ...(b.until ? { lt: b.until } : {}) } } })
      : Promise.resolve(null),
    senderRows(c),
    c.deps.prisma.email.findFirst({ where: { userId: c.userId, status: 'RATE_LIMITED' }, orderBy: { nextAttemptAt: 'asc' }, select: { nextAttemptAt: true } }),
  ]);
  const waiting = m.scheduled + m.deferred + m.sending;
  const sent = sentInRange ?? m.sent;
  const active = c.campaigns.filter((x) => x.status === 'ACTIVE').length;
  const paused = c.campaigns.filter((x) => x.status === 'PAUSED').length;
  const hot = senders.filter((s) => s.ratio >= 0.8);

  const notes: string[] = [];
  if (m.failed) notes.push(`${plural(m.failed, 'email')} failed.`);
  if (m.deferred && nextDeferred) notes.push(`${plural(m.deferred, 'email')} ${m.deferred === 1 ? 'is' : 'are'} waiting for a rate-limit window (next resumes ${fmtWhen(nextDeferred.nextAttemptAt, c.tz)}).`);
  if (paused) notes.push(`${plural(paused, 'campaign')} ${paused === 1 ? 'is' : 'are'} paused.`);
  if (hot.length) notes.push(`${hot.map((s) => s.email).join(', ')} ${hot.length === 1 ? 'is' : 'are'} near ${hot.length === 1 ? 'its' : 'their'} sending limit.`);

  const suggestions: string[] = [];
  if (m.failed) suggestions.push('Why did emails fail?', 'Retry all failed emails');
  if (m.deferred) suggestions.push('When do deferred emails resume?');
  if (paused) suggestions.push('Show paused campaigns');
  suggestions.push('Which sender is closest to its limit?', "What's next to send?");

  return base(
    'overview',
    `${b.since ? `Sent ${b.label}: ${nf.format(sent)}` : `${nf.format(sent)} sent so far`}, ${nf.format(waiting)} still waiting, ${nf.format(m.failed)} failed, across ${plural(active, 'active campaign')}. ${notes.length ? notes.join(' ') : 'Nothing needs your attention.'}`,
    {
      blocks: [
        stats([
          { label: b.since ? `Sent ${b.label}` : 'Sent', value: sent, tone: 'success' },
          { label: 'Waiting', value: waiting, tone: 'info' },
          { label: 'Deferred by limits', value: m.deferred, tone: m.deferred ? 'warning' : 'neutral' },
          { label: 'Failed', value: m.failed, tone: m.failed ? 'danger' : 'neutral' },
        ]),
      ],
      suggestions: suggestions.slice(0, 5),
    },
  );
}

/** Which timestamp a status is "about" — so "failed today" means failed today, not created today. */
function rangeWhere(statuses: EmailStatus[] | null, since?: Date, until?: Date): Prisma.EmailWhereInput {
  if (!since) return {};
  const field = !statuses ? 'createdAt' : statuses[0] === 'SENT' ? 'sentAt' : statuses[0] === 'FAILED' ? 'failedAt' : statuses[0] === 'CANCELLED' ? 'updatedAt' : 'scheduledAt';
  return { [field]: { gte: since, ...(until ? { lt: until } : {}) } };
}

async function count(c: Ctx, i: Extract<Intent, { kind: 'count' }>): Promise<AssistantReply> {
  const b = rangeBounds(i.range, c.tz);
  const where: Prisma.EmailWhereInput = {
    userId: c.userId,
    ...(i.statuses ? { status: { in: i.statuses } } : {}),
    ...rangeWhere(i.statuses, b.since, b.until),
  };
  const n = await c.deps.prisma.email.count({ where });
  const when = b.since ? ` ${b.label}` : '';
  const onlySent = i.statuses?.length === 1 && i.statuses[0] === 'SENT';
  const failedToo = onlySent ? await c.deps.prisma.email.count({ where: { userId: c.userId, status: 'FAILED', ...rangeWhere(['FAILED'], b.since, b.until) } }) : 0;
  const text0 = i.statuses ? (n === 0 ? `No emails are ${i.label}${when}.` : `${plural(n, 'email')} ${n === 1 ? 'is' : 'are'} ${i.label}${when}.`) : `You have ${plural(n, 'email')}${b.since ? ` created ${b.label}` : ' in total'}.`;
  const text = failedToo > 0 ? `${text0} ${nf.format(failedToo)} more failed, so the Sent tab shows ${nf.format(n + failedToo)}.` : text0;

  const blocks: AssistantBlock[] = [];
  if (!i.statuses) {
    const m = await statusMap(c);
    blocks.push(stats([{ label: 'Sent', value: m.sent, tone: 'success' }, { label: 'Waiting', value: m.scheduled + m.deferred + m.sending, tone: 'info' }, { label: 'Failed', value: m.failed, tone: m.failed ? 'danger' : 'neutral' }, { label: 'Cancelled', value: m.cancelled }]));
  } else {
    blocks.push(stats([{ label: `${i.label[0]!.toUpperCase()}${i.label.slice(1)}${when}`, value: n, tone: i.statuses[0] === 'FAILED' ? (n ? 'danger' : 'neutral') : i.statuses[0] === 'SENT' ? 'success' : 'info' }]));
  }
  const suggestions = i.statuses?.[0] === 'FAILED' && n > 0 ? ['Why did emails fail?', 'Retry all failed emails', 'Export failed emails'] : ['Give me an overview', 'Which sender is closest to its limit?'];
  return base('count', text, { blocks, suggestions });
}

async function failureReasons(c: Ctx, range: RangeSpec): Promise<AssistantReply> {
  const b = rangeBounds(range, c.tz);
  const rows = await c.deps.prisma.email.groupBy({
    by: ['lastError'],
    where: { userId: c.userId, status: 'FAILED', ...rangeWhere(['FAILED'], b.since, b.until) },
    _count: { _all: true },
    orderBy: { _count: { lastError: 'desc' } },
    take: 8,
  });
  const total = rows.reduce((s, r) => s + r._count._all, 0);
  if (total === 0) return base('failure_reasons', `No failed emails${b.since ? ` ${b.label}` : ''}.`, { suggestions: ['Give me an overview'] });

  const reasonText = (e: string | null) => (e === 'interrupted_before_confirmation' ? 'Interrupted before confirmation (a crash/restart mid-send — not re-sent to avoid a duplicate)' : (e ?? 'No error recorded'));
  const top = rows[0]!;
  return base('failure_reasons', `${plural(total, 'email')} failed${b.since ? ` ${b.label}` : ''}. The most common reason: ${reasonText(top.lastError)} (${nf.format(top._count._all)}).`, {
    blocks: [{ type: 'table', columns: ['Reason', 'Emails'], rows: rows.map((r) => [trunc(reasonText(r.lastError), 90), nf.format(r._count._all)]), link: { label: 'Open the Sent tab', to: '/dashboard/sent' } }],
    suggestions: ['Retry all failed emails', 'Export failed emails', 'Show me failed emails'],
  });
}

async function failedList(c: Ctx): Promise<AssistantReply> {
  const [rows, total] = await Promise.all([
    c.deps.prisma.email.findMany({ where: { userId: c.userId, status: 'FAILED' }, orderBy: { failedAt: 'desc' }, take: 8, include: { campaign: { select: { subject: true } } } }),
    c.deps.prisma.email.count({ where: { userId: c.userId, status: 'FAILED' } }),
  ]);
  if (total === 0) return base('failed_list', 'No emails have failed.', { suggestions: ['Give me an overview'] });
  return base('failed_list', `${plural(total, 'email')} failed. The latest ${rows.length}:`, {
    blocks: [{ type: 'table', columns: ['To', 'Campaign', 'Error', 'When'], rows: rows.map((r) => [r.toEmail, quote(r.campaign.subject), trunc(r.lastError ?? '—', 50), r.failedAt ? fmtWhen(r.failedAt, c.tz) : '—']), link: { label: 'Open the Sent tab', to: '/dashboard/sent' } }],
    suggestions: ['Why did emails fail?', 'Retry all failed emails', 'Export failed emails'],
  });
}

const statusWord: Record<string, string> = { ACTIVE: 'active', PAUSED: 'paused', COMPLETED: 'completed', CANCELLED: 'cancelled' };

async function campaignsList(c: Ctx, i: Extract<Intent, { kind: 'campaigns_list' }>): Promise<AssistantReply> {
  const filter = i.filter?.toUpperCase();
  const list = filter ? c.campaigns.filter((x) => x.status === filter) : c.campaigns;
  const label = i.filter ? `${i.filter} campaign` : 'campaign';
  if (i.countOnly) {
    return base('campaigns_list', `You have ${plural(list.length, label)}${filter ? '' : ` (${c.campaigns.filter((x) => x.status === 'ACTIVE').length} active)`}.`, { suggestions: ['Show my campaigns', 'Give me an overview'] });
  }
  if (list.length === 0) return base('campaigns_list', i.filter ? `You have no ${i.filter} campaigns.` : 'You have no campaigns yet. Compose one to get started.', { navigate: i.filter ? undefined : { to: '/compose', label: 'Compose' }, suggestions: ['Show my campaigns'] });
  const shown = list.slice(0, 8);
  return base('campaigns_list', `${plural(list.length, label)}${list.length > shown.length ? ` — showing the latest ${shown.length}` : ''}:`, {
    blocks: [
      {
        type: 'list',
        items: shown.map((x) => {
          const processed = x.counts.sent + x.counts.failed;
          return {
            title: `${quote(x.subject)}  #${shortId(x.id)}`,
            subtitle: `${statusWord[x.status] ?? x.status.toLowerCase()} · ${nf.format(processed)} of ${nf.format(x.total)} processed${x.counts.failed ? ` · ${x.counts.failed} failed` : ''}`,
            to: '/campaigns',
            tone: x.status === 'PAUSED' ? 'warning' : x.status === 'COMPLETED' ? 'success' : 'info',
          };
        }),
      },
    ],
    suggestions: shown[0] ? [`How is #${shortId(shown[0].id)} doing?`, 'Give me an overview'] : [],
  });
}

function ambiguous(intent: string, target: Extract<CampaignTarget, { kind: 'ambiguous' }>, verb: string): AssistantReply {
  return base(intent, `I found ${target.refs.length} campaigns that could match. Which one do you mean?`, {
    blocks: [{ type: 'list', items: target.refs.slice(0, 6).map((r) => ({ title: `${quote(r.subject)}  #${shortId(r.id)}`, subtitle: statusWord[r.status] ?? r.status.toLowerCase() })) }],
    suggestions: target.refs.slice(0, 4).map((r) => `${verb} #${shortId(r.id)}`),
  });
}

function needCampaign(c: Ctx, intent: string, verb: string, prompt = 'Which campaign?'): AssistantReply {
  const recent = c.campaigns.slice(0, 4);
  if (recent.length === 0) return base(intent, 'You don’t have any campaigns yet.', { navigate: { to: '/compose', label: 'Compose' } });
  return base(intent, `${prompt} Name it (or its #id) and I’ll take it from there.`, {
    blocks: [{ type: 'list', items: recent.map((r) => ({ title: `${quote(r.subject)}  #${shortId(r.id)}`, subtitle: statusWord[r.status] ?? r.status.toLowerCase() })) }],
    suggestions: recent.map((r) => `${verb} #${shortId(r.id)}`),
  });
}

async function campaignReport(c: Ctx, target: CampaignTarget, asks: 'finish' | 'status'): Promise<AssistantReply> {
  if (target.kind === 'ambiguous') return ambiguous('campaign_report', target, asks === 'finish' ? 'When will' : 'How is');
  if (target.kind === 'none') return needCampaign(c, 'campaign_report', 'How is', 'Which campaign do you mean?');
  const camp = c.campaigns.find((x) => x.id === target.ref.id)!;
  const k = camp.counts;
  const processed = k.sent + k.failed;
  const pending = k.scheduled + k.rateLimited + k.sending;
  const pct = camp.total ? Math.round((processed / camp.total) * 100) : 0;
  const head = `${quote(camp.subject)} is ${statusWord[camp.status] ?? camp.status.toLowerCase()}: ${nf.format(processed)} of ${nf.format(camp.total)} processed (${pct}%) — ${nf.format(k.sent)} sent${k.failed ? `, ${nf.format(k.failed)} failed` : ''}${k.rateLimited ? `, ${nf.format(k.rateLimited)} deferred by a limit` : ''}.`;

  let finish = '';
  if (camp.status === 'CANCELLED') finish = ' It was cancelled, so nothing more will be sent.';
  else if (camp.status === 'PAUSED') finish = ` It is paused with ${plural(pending, 'email')} on hold.`;
  else if (pending === 0) finish = ' Everything has been processed.';
  else if (camp.lastPendingAt) finish = ` The last email is expected ${fmtWhen(new Date(camp.lastPendingAt), c.tz)} (${fmtRelative(new Date(camp.lastPendingAt).getTime())}).`;

  const suggestions: string[] = [];
  if (camp.status === 'ACTIVE' && pending > 0) suggestions.push(`Pause #${shortId(camp.id)}`);
  if (camp.status === 'PAUSED') suggestions.push(`Resume #${shortId(camp.id)}`);
  if (k.failed) suggestions.push(`Retry failed in #${shortId(camp.id)}`);
  suggestions.push(`Export #${shortId(camp.id)}`);

  return base('campaign_report', asks === 'finish' && pending > 0 && camp.status === 'ACTIVE' ? `${head}${finish}` : `${head}${finish}`, {
    blocks: [
      stats([
        { label: 'Sent', value: k.sent, tone: 'success' },
        { label: 'Waiting', value: k.scheduled + k.sending, tone: 'info' },
        { label: 'Deferred', value: k.rateLimited, tone: k.rateLimited ? 'warning' : 'neutral' },
        { label: 'Failed', value: k.failed, tone: k.failed ? 'danger' : 'neutral' },
      ]),
    ],
    suggestions,
    context: { campaignId: camp.id },
  });
}

async function emailLookup(c: Ctx, address: string): Promise<AssistantReply> {
  const rows = await c.deps.prisma.email.findMany({
    where: { userId: c.userId, toEmail: address },
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { campaign: { select: { subject: true, status: true } }, sender: { select: { email: true } }, events: { orderBy: { at: 'asc' }, select: { type: true, at: true, meta: true } } },
  });
  const blocked = await c.deps.prisma.suppressedEmail.findUnique({ where: { userId_email: { userId: c.userId, email: address } } });
  if (rows.length === 0) {
    return base('email_lookup', `I can’t find any email to ${address}${blocked ? ', but it is on your do-not-contact list' : ''}.`, { suggestions: [blocked ? `Unblock ${address}` : `Block ${address}`] });
  }
  const e = rows[0]!;
  const statusText: Record<string, string> = { SENT: 'was sent', FAILED: 'failed', SCHEDULED: 'is scheduled', RATE_LIMITED: 'is waiting for a rate-limit window', SENDING: 'is being sent right now', CANCELLED: 'was cancelled' };
  const when = e.status === 'SENT' && e.sentAt ? ` ${fmtWhen(e.sentAt, c.tz)}` : e.status === 'FAILED' && e.failedAt ? ` ${fmtWhen(e.failedAt, c.tz)}` : e.status === 'SCHEDULED' || e.status === 'RATE_LIMITED' ? ` — next attempt ${fmtWhen(e.nextAttemptAt, c.tz)}` : '';
  const err = e.status === 'FAILED' && e.lastError ? ` Reason: ${e.lastError}.` : '';
  const more = rows.length > 1 ? ` (${rows.length - 1} earlier email${rows.length === 2 ? '' : 's'} to this address too.)` : '';

  const events = e.events.length ? e.events : [{ type: 'SCHEDULED' as const, at: e.createdAt, meta: null }];
  const label: Record<string, string> = { SCHEDULED: 'Scheduled', RATE_LIMITED: 'Deferred by a limit', SEND_ERROR: 'Send attempt failed', SENT: 'Sent', FAILED: 'Failed', RETRIED: 'Retried', CANCELLED: 'Cancelled', PAUSED: 'Campaign paused', RESUMED: 'Campaign resumed' };
  const suggestions: string[] = [];
  if (e.status === 'FAILED') suggestions.push(`Retry ${address}`);
  if (e.status === 'SCHEDULED' || e.status === 'RATE_LIMITED') suggestions.push(`Cancel the email to ${address}`);
  suggestions.push(blocked ? `Unblock ${address}` : `Block ${address}`);

  return base('email_lookup', `The email to ${address} in ${quote(e.campaign.subject)} ${statusText[e.status]}${when}.${err}${blocked ? ' This address is on your do-not-contact list.' : ''}${more}`, {
    blocks: [
      {
        type: 'timeline',
        items: events.map((ev) => ({
          label: label[ev.type] ?? ev.type,
          at: ev.at.toISOString(),
          detail: typeof (ev.meta as { error?: unknown } | null)?.error === 'string' ? (ev.meta as { error: string }).error : undefined,
          tone: ev.type === 'FAILED' ? 'danger' : ev.type === 'SENT' ? 'success' : ev.type === 'RATE_LIMITED' || ev.type === 'SEND_ERROR' ? 'warning' : 'neutral',
        })),
      },
    ],
    suggestions,
    context: { emailId: e.id, campaignId: e.campaignId },
  });
}

async function searchEmails(c: Ctx, term: string): Promise<AssistantReply> {
  let rows: { id: string; toEmail: string; subject: string; status: string }[] = [];
  let via = 'Elasticsearch';
  try {
    if (!c.deps.search) throw new Error('no search');
    const found = await c.deps.search.search(c.userId, { q: term, page: 1, size: 8 });
    const byId = new Map((await c.deps.prisma.email.findMany({ where: { id: { in: found.ids }, userId: c.userId }, select: { id: true, toEmail: true, subject: true, status: true } })).map((r) => [r.id, r]));
    rows = found.ids.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
  } catch {
    // Search is a convenience; if Elasticsearch is down, fall back to a plain database match.
    via = 'the database';
    rows = await c.deps.prisma.email.findMany({
      where: { userId: c.userId, OR: [{ toEmail: { contains: term, mode: 'insensitive' } }, { subject: { contains: term, mode: 'insensitive' } }, { body: { contains: term, mode: 'insensitive' } }] },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, toEmail: true, subject: true, status: true },
    });
  }
  if (rows.length === 0) return base('search', `Nothing matched “${term}”.`, { suggestions: ['Show my campaigns'] });
  return base('search', `Found ${plural(rows.length, 'email')} for “${term}” (via ${via}):`, {
    blocks: [{ type: 'table', columns: ['To', 'Subject', 'Status'], rows: rows.map((r) => [r.toEmail, trunc(r.subject, 50), r.status.toLowerCase().replace('_', ' ')]), link: { label: 'Open in Sent', to: `/dashboard/sent?q=${encodeURIComponent(term)}` } }],
    suggestions: [`Export the emails`],
  });
}

async function exportCsv(c: Ctx, scope: 'failed' | 'sent' | 'scheduled' | 'all', target: CampaignTarget): Promise<AssistantReply> {
  if (target.kind === 'ambiguous') return ambiguous('export', target, 'Export');
  const qs = new URLSearchParams();
  if (scope === 'failed') qs.set('status', 'FAILED');
  else if (scope === 'sent') qs.set('tab', 'sent');
  else if (scope === 'scheduled') qs.set('tab', 'scheduled');
  if (target.kind === 'one') qs.set('campaignId', target.ref.id);
  const what = `${scope === 'all' ? 'all' : scope} emails${target.kind === 'one' ? ` from ${quote(target.ref.subject)}` : ''}`;
  return base('export', `Here is your CSV of ${what}.`, { download: { url: `/api/emails/export?${qs}`, label: `Download ${what} (CSV)` }, context: target.kind === 'one' ? { campaignId: target.ref.id } : undefined });
}

async function nextSends(c: Ctx): Promise<AssistantReply> {
  const rows = await c.deps.prisma.email.findMany({
    where: { userId: c.userId, status: { in: [...WAITING] }, campaign: { status: 'ACTIVE' } },
    orderBy: [{ nextAttemptAt: 'asc' }, { sequence: 'asc' }],
    take: 5,
    include: { campaign: { select: { subject: true } } },
  });
  if (rows.length === 0) return base('next_sends', 'Nothing is queued right now. Everything has been sent, or your campaigns are paused.', { suggestions: ['Show paused campaigns', 'Give me an overview'] });
  const first = rows[0]!;
  return base('next_sends', `Next up: ${first.toEmail}, ${fmtWhen(first.nextAttemptAt, c.tz)} (${fmtRelative(first.nextAttemptAt.getTime())}).`, {
    blocks: [{ type: 'table', columns: ['To', 'Campaign', 'When', 'Status'], rows: rows.map((r) => [r.toEmail, quote(r.campaign.subject), fmtWhen(r.nextAttemptAt, c.tz), r.status === 'RATE_LIMITED' ? 'deferred by a limit' : 'scheduled']), link: { label: 'Open Scheduled', to: '/dashboard/scheduled' } }],
    suggestions: ['When will everything finish?', 'Are we being rate limited?'],
  });
}

async function etaAll(c: Ctx): Promise<AssistantReply> {
  const [agg, onHold] = await Promise.all([
    c.deps.prisma.email.aggregate({ where: { userId: c.userId, status: { in: [...PENDING] }, campaign: { status: 'ACTIVE' } }, _max: { nextAttemptAt: true }, _count: { _all: true } }),
    c.deps.prisma.email.count({ where: { userId: c.userId, status: { in: [...WAITING] }, campaign: { status: 'PAUSED' } } }),
  ]);
  const n = agg._count._all;
  const hold = onHold ? ` ${plural(onHold, 'email')} ${onHold === 1 ? 'is' : 'are'} on hold in paused campaigns.` : '';
  if (n === 0) return base('eta_all', `Nothing is waiting to be sent.${hold}`, { suggestions: ['Show paused campaigns'] });
  const last = agg._max.nextAttemptAt!;
  return base('eta_all', `${plural(n, 'email')} still to go. The last one is expected ${fmtWhen(last, c.tz)} (${fmtRelative(last.getTime())}).${hold}`, {
    blocks: [stats([{ label: 'Still to send', value: n, tone: 'info' }, { label: 'Expected finish', value: fmtWhen(last, c.tz) }])],
    suggestions: ["What's next to send?", 'Are we being rate limited?'],
  });
}

async function rateLimits(c: Ctx): Promise<AssistantReply> {
  const b = rangeBounds({ kind: 'today' }, c.tz);
  const [byEmail, hitsToday] = await Promise.all([
    c.deps.prisma.email.findMany({ where: { userId: c.userId, status: 'RATE_LIMITED', campaign: { status: 'ACTIVE' } }, select: { nextAttemptAt: true, sender: { select: { email: true } } } }),
    c.deps.prisma.emailEvent.count({ where: { userId: c.userId, type: 'RATE_LIMITED', at: { gte: b.since } } }),
  ]);
  if (byEmail.length === 0) {
    return base('rate_limits', hitsToday ? `No emails are being held back right now. Limits were hit ${plural(hitsToday, 'time')} today, but everything has since gone out.` : 'No emails are being held back by rate limits.', { suggestions: ['Which sender is closest to its limit?'] });
  }
  const times = byEmail.map((e) => e.nextAttemptAt.getTime());
  const earliest = Math.min(...times);
  const bySender = new Map<string, number>();
  for (const e of byEmail) bySender.set(e.sender.email, (bySender.get(e.sender.email) ?? 0) + 1);
  return base('rate_limits', `${plural(byEmail.length, 'email')} ${byEmail.length === 1 ? 'is' : 'are'} waiting for a rate-limit window. The next batch resumes ${fmtWhen(earliest, c.tz)} (${fmtRelative(earliest)}). Nothing is dropped — they keep their order.`, {
    blocks: [{ type: 'table', columns: ['Sender', 'Waiting'], rows: [...bySender].sort((a, b2) => b2[1] - a[1]).map(([s, n]) => [s, nf.format(n)]) }],
    suggestions: ['Which sender is closest to its limit?', 'When will everything finish?'],
  });
}

async function senderUsage(c: Ctx): Promise<AssistantReply> {
  const rows = (await senderRows(c)).sort((a, b) => b.ratio - a.ratio);
  if (rows.length === 0) return base('sender_usage', 'No sending accounts are set up yet. Run `npm run senders:create -w @ri/api`.');
  const top = rows[0]!;
  const full = rows.filter((r) => r.used >= r.limit).length;
  const summary = top.used === 0
    ? `No sender has used any of its allowance this window — each still has its full limit available (${top.limit} for ${top.email}).`
    : `${top.email} is the closest to its limit: ${top.used} of ${top.limit} this window${top.used >= top.limit ? ' (reached)' : ''}.${full ? ` ${plural(full, 'sender')} ${full === 1 ? 'has' : 'have'} reached the limit.` : ''}`;
  return base('sender_usage', summary, {
    blocks: [{ type: 'bars', items: rows.map((r) => ({ label: r.email, value: r.used, max: r.limit, hint: `${r.used}/${r.limit}`, tone: r.used >= r.limit ? 'danger' : r.ratio >= 0.8 ? 'warning' : 'success' })) }],
    suggestions: ['Are we being rate limited?', 'When will everything finish?'],
  });
}

async function slackStatus(c: Ctx): Promise<AssistantReply> {
  const s = await c.deps.prisma.slackConnection.findUnique({ where: { userId: c.userId } });
  if (!s) return base('slack', 'Slack is not connected. Connect it in Settings to get an alert whenever a sender hits its limit.', { navigate: { to: '/settings', label: 'Settings' } });
  if (!s.isValid) return base('slack', `Slack stopped accepting messages for ${s.channelName} in ${s.teamName}. Reconnect it in Settings.`, { navigate: { to: '/settings', label: 'Settings' } });
  return base('slack', `Slack is connected: alerts go to ${s.channelName} in ${s.teamName}.`, { suggestions: ['Open settings'] });
}

async function health(c: Ctx): Promise<AssistantReply> {
  const svc = await (c.deps.health?.() ?? Promise.resolve({ db: true, redis: true, elasticsearch: true }));
  const counts = await c.deps.queues.email.getJobCounts('waiting', 'active', 'delayed', 'failed').catch(() => null);
  const workers = await c.deps.queues.email.getWorkers().then((w) => w.length).catch(() => null);
  const down = [!svc.db && 'Postgres', !svc.redis && 'Redis', !svc.elasticsearch && 'Elasticsearch (search only)'].filter(Boolean) as string[];
  const tone = (ok: boolean) => (ok ? 'success' : 'danger') as 'success' | 'danger';
  const workerText = workers === null ? '' : workers > 0 ? ` ${plural(workers, 'worker')} connected.` : ' No worker is connected — emails will not send until one starts.';
  return base('health', `${down.length ? `Problem: ${down.join(', ')} ${down.length === 1 ? 'is' : 'are'} down.` : 'Everything is up: Postgres, Redis and Elasticsearch.'}${workerText}${counts ? ` Email queue: ${counts.delayed ?? 0} scheduled, ${counts.waiting ?? 0} ready, ${counts.active ?? 0} sending.` : ''}`, {
    blocks: [
      stats([
        { label: 'Postgres', value: svc.db ? 'up' : 'down', tone: tone(svc.db) },
        { label: 'Redis', value: svc.redis ? 'up' : 'down', tone: tone(svc.redis) },
        { label: 'Search', value: svc.elasticsearch ? 'up' : 'down', tone: tone(svc.elasticsearch) },
        ...(workers !== null ? [{ label: 'Workers', value: workers, tone: (workers > 0 ? 'success' : 'danger') as 'success' | 'danger' }] : []),
      ]),
    ],
    suggestions: ['Give me an overview', "What's next to send?"],
  });
}

async function dncOverview(c: Ctx): Promise<AssistantReply> {
  const [total, recent] = await Promise.all([
    c.deps.prisma.suppressedEmail.count({ where: { userId: c.userId } }),
    c.deps.prisma.suppressedEmail.findMany({ where: { userId: c.userId }, orderBy: { createdAt: 'desc' }, take: 8 }),
  ]);
  if (total === 0) return base('dnc_count', 'Your do-not-contact list is empty.', { suggestions: ['Block jane@example.com'] });
  return base('dnc_count', `${plural(total, 'address', 'addresses')} ${total === 1 ? 'is' : 'are'} on your do-not-contact list. The most recent:`, {
    blocks: [{ type: 'list', items: recent.map((r) => ({ title: r.email, subtitle: `added ${fmtWhen(r.createdAt, c.tz)}` })) }],
    navigate: { to: '/settings#do-not-contact', label: 'Do-not-contact list' },
  });
}

async function dncCheck(c: Ctx, emails: string[]): Promise<AssistantReply> {
  const hits = await c.deps.prisma.suppressedEmail.findMany({ where: { userId: c.userId, email: { in: emails } }, select: { email: true } });
  const set = new Set(hits.map((h) => h.email));
  const lines = emails.map((e) => `${e}: ${set.has(e) ? 'blocked (on the do-not-contact list)' : 'not blocked'}`);
  return base('dnc_check', emails.length === 1 ? `${lines[0]}.` : lines.join('. ') + '.', {
    suggestions: emails.map((e) => (set.has(e) ? `Unblock ${e}` : `Block ${e}`)).slice(0, 3),
  });
}

// ── proposals (nothing changes until Confirm) ────────────────────────────────

type Proposal = { tool: string; args: Record<string, unknown>; title: string; description: string; danger?: boolean; confirmLabel: string; summary: string };

async function propose(c: Ctx, intent: string, p: Proposal, extra: Partial<AssistantReply> = {}): Promise<AssistantReply> {
  const id = randomUUID();
  await c.deps.redis.set(pendingKey(c.userId, id), JSON.stringify({ tool: p.tool, args: p.args, summary: p.summary }), 'EX', PENDING_TTL_SEC);
  return base(intent, `${p.title} ${p.description}`, {
    ...extra,
    pending: { id, tool: p.tool, title: p.title, description: p.description, danger: p.danger ?? false, confirmLabel: p.confirmLabel, expiresAt: new Date(Date.now() + PENDING_TTL_SEC * 1000).toISOString() },
  });
}

async function campaignAction(c: Ctx, action: CampaignAction, target: CampaignTarget): Promise<AssistantReply> {
  const verb = { pause: 'Pause', resume: 'Resume', cancel: 'Cancel', retry_failed: 'Retry failed in' }[action];
  if (target.kind === 'ambiguous') return ambiguous('campaign_action', target, verb);
  if (target.kind === 'none') return needCampaign(c, 'campaign_action', verb, `Which campaign should I ${action === 'retry_failed' ? 'retry failed emails in' : action}?`);

  const camp = c.campaigns.find((x) => x.id === target.ref.id)!;
  const k = camp.counts;
  const pending = k.scheduled + k.rateLimited + k.sending;
  const name = quote(camp.subject);
  const ctxRef = { context: { campaignId: camp.id } };
  const args = { campaignId: camp.id, subject: camp.subject };

  if (action === 'pause') {
    if (camp.status === 'PAUSED') return base('campaign_action', `${name} is already paused.`, { ...ctxRef, suggestions: [`Resume #${shortId(camp.id)}`] });
    if (camp.status === 'CANCELLED') return base('campaign_action', `${name} was cancelled, so there is nothing to pause.`, ctxRef);
    if (pending === 0) return base('campaign_action', `${name} has nothing left to send, so there is nothing to pause.`, ctxRef);
    return propose(c, 'campaign_action', { tool: 'pause_campaign', args, title: `Pause ${name}?`, description: `${plural(pending, 'email')} will be put on hold and keep their place in line. Nothing is lost, and you can resume any time.`, confirmLabel: 'Pause campaign', summary: `Paused campaign ${camp.subject}` }, ctxRef);
  }
  if (action === 'resume') {
    if (camp.status !== 'PAUSED') return base('campaign_action', `${name} isn’t paused (it is ${statusWord[camp.status] ?? camp.status.toLowerCase()}).`, ctxRef);
    return propose(c, 'campaign_action', { tool: 'resume_campaign', args, title: `Resume ${name}?`, description: `${plural(pending, 'email')} will continue in their original order, still respecting your rate limits.`, confirmLabel: 'Resume campaign', summary: `Resumed campaign ${camp.subject}` }, ctxRef);
  }
  if (action === 'cancel') {
    if (camp.status === 'CANCELLED') return base('campaign_action', `${name} is already cancelled.`, ctxRef);
    if (pending === 0) return base('campaign_action', `${name} has nothing left to send, so there is nothing to cancel.`, ctxRef);
    return propose(c, 'campaign_action', { tool: 'cancel_campaign', args, danger: true, title: `Cancel ${name}?`, description: `${plural(pending, 'pending email')} will be cancelled permanently. Emails already sent are unaffected. This can’t be undone.`, confirmLabel: 'Cancel campaign', summary: `Cancelled campaign ${camp.subject}` }, ctxRef);
  }
  if (camp.status === 'CANCELLED') return base('campaign_action', `${name} was cancelled, so its failed emails can’t be retried.`, ctxRef);
  if (k.failed === 0) return base('campaign_action', `${name} has no failed emails.`, ctxRef);
  return propose(c, 'campaign_action', { tool: 'retry_failed', args, title: `Retry ${plural(k.failed, 'failed email')}?`, description: `In ${name}. They go back into the queue and are sent as soon as your limits allow.`, confirmLabel: `Retry ${k.failed}`, summary: `Retried ${k.failed} failed emails in ${camp.subject}` }, ctxRef);
}

async function proposeRetryAll(c: Ctx): Promise<AssistantReply> {
  const withFailures = c.campaigns.filter((x) => x.counts.failed > 0 && x.status !== 'CANCELLED');
  const total = withFailures.reduce((s, x) => s + x.counts.failed, 0);
  if (total === 0) return base('retry_all_failed', 'There are no failed emails to retry.', { suggestions: ['Give me an overview'] });
  return propose(c, 'retry_all_failed', { tool: 'retry_all_failed', args: { campaignIds: withFailures.map((x) => x.id) }, title: `Retry ${plural(total, 'failed email')}?`, description: `${plural(total, 'failed email')} across ${plural(withFailures.length, 'campaign')} will go back into the queue and be sent as soon as your limits allow.`, confirmLabel: `Retry ${total}`, summary: `Retried ${total} failed emails across ${withFailures.length} campaigns` });
}

async function emailAction(c: Ctx, action: 'retry' | 'cancel', address: string): Promise<AssistantReply> {
  const rows = await c.deps.prisma.email.findMany({ where: { userId: c.userId, toEmail: address }, orderBy: { createdAt: 'desc' }, take: 10, include: { campaign: { select: { subject: true, status: true } } } });
  if (rows.length === 0) return base('email_action', `I can’t find any email to ${address}.`);
  if (action === 'retry') {
    const e = rows.find((r) => r.status === 'FAILED' && r.campaign.status !== 'CANCELLED');
    if (!e) return base('email_action', `None of the emails to ${address} are in a failed state, so there is nothing to retry.`, { context: { emailId: rows[0]!.id } });
    return propose(c, 'email_action', { tool: 'retry_email', args: { emailId: e.id, to: address }, title: `Retry the email to ${address}?`, description: `It failed in ${quote(e.campaign.subject)}. It goes back into the queue and is sent as soon as your limits allow.`, confirmLabel: 'Retry email', summary: `Retried email to ${address}` }, { context: { emailId: e.id } });
  }
  const e = rows.find((r) => (WAITING as readonly string[]).includes(r.status));
  if (!e) return base('email_action', `No email to ${address} is waiting to be sent, so there is nothing to cancel.`, { context: { emailId: rows[0]!.id } });
  return propose(c, 'email_action', { tool: 'cancel_email', args: { emailId: e.id, to: address }, danger: true, title: `Cancel the email to ${address}?`, description: `The scheduled email in ${quote(e.campaign.subject)} won’t be sent. This can’t be undone.`, confirmLabel: 'Cancel email', summary: `Cancelled email to ${address}` }, { context: { emailId: e.id } });
}

async function proposeDncAdd(c: Ctx, emails: string[]): Promise<AssistantReply> {
  const valid = emails.filter(isValidEmail);
  if (valid.length === 0) return base('dnc_add', 'Those don’t look like valid email addresses.');
  const [already, pending] = await Promise.all([
    c.deps.prisma.suppressedEmail.count({ where: { userId: c.userId, email: { in: valid } } }),
    c.deps.prisma.email.count({ where: { userId: c.userId, toEmail: { in: valid }, status: { in: [...WAITING] } } }),
  ]);
  const fresh = valid.length - already;
  if (fresh === 0) return base('dnc_add', valid.length === 1 ? `${valid[0]} is already on your do-not-contact list.` : 'All of those are already on your do-not-contact list.');
  const list = valid.slice(0, 4).join(', ') + (valid.length > 4 ? ` and ${valid.length - 4} more` : '');
  return propose(c, 'dnc_add', { tool: 'dnc_add', args: { emails: valid }, title: `Block ${plural(fresh, 'address', 'addresses')}?`, description: `${list} will be skipped in every future campaign${pending ? `, and ${plural(pending, 'scheduled email')} to them will be cancelled` : ''}.`, confirmLabel: 'Add to list', summary: `Added ${fresh} address(es) to the do-not-contact list` });
}

async function proposeDncRemove(c: Ctx, emails: string[]): Promise<AssistantReply> {
  const listed = await c.deps.prisma.suppressedEmail.findMany({ where: { userId: c.userId, email: { in: emails } }, select: { email: true } });
  if (listed.length === 0) return base('dnc_remove', emails.length === 1 ? `${emails[0]} isn’t on your do-not-contact list.` : 'None of those are on your do-not-contact list.');
  const list = listed.map((l) => l.email).slice(0, 4).join(', ') + (listed.length > 4 ? ` and ${listed.length - 4} more` : '');
  return propose(c, 'dnc_remove', { tool: 'dnc_remove', args: { emails: listed.map((l) => l.email) }, title: `Unblock ${plural(listed.length, 'address', 'addresses')}?`, description: `${list} can be emailed again by future campaigns.`, confirmLabel: 'Remove from list', summary: `Removed ${listed.length} address(es) from the do-not-contact list` });
}

// ── confirm / cancel ─────────────────────────────────────────────────────────

const pendingKey = (userId: string, id: string) => `assistant:pending:${userId}:${id}`;

type Stored = { tool: string; args: Record<string, unknown>; summary: string };

async function audit(deps: AssistantDeps, userId: string, tool: string, args: unknown, status: 'EXECUTED' | 'CANCELLED' | 'FAILED', summary: string) {
  await deps.prisma.assistantAction.create({ data: { userId, tool, args: args as Prisma.InputJsonValue, status, summary } }).catch((err) => logger.warn({ err }, 'assistant audit write failed'));
}

/** Runs a previously proposed change. The proposal is consumed atomically, so it can only run once. */
export async function confirmAction(userId: string, id: string, deps: AssistantDeps): Promise<AssistantReply> {
  const raw = await deps.redis.getdel(pendingKey(userId, id));
  if (!raw) return base('confirm_expired', 'That confirmation has expired or was already used. Ask me again and I’ll set it up.', { suggestions: STARTERS.slice(0, 3) });
  const p = JSON.parse(raw) as Stored;
  const controls: ControlDeps = { prisma: deps.prisma, queues: deps.queues, redis: deps.redis };
  const a = p.args as Record<string, string & string[]>;

  try {
    let text: string;
    let suggestions: string[] = ['Give me an overview'];
    let context: AssistantReply['context'];
    switch (p.tool) {
      case 'pause_campaign':
        await pauseCampaign(userId, a.campaignId!, controls);
        text = `Paused ${quote(a.subject!)}. Its emails are on hold and keep their place in line.`;
        suggestions = [`Resume #${shortId(a.campaignId!)}`, `How is #${shortId(a.campaignId!)} doing?`];
        context = { campaignId: a.campaignId };
        break;
      case 'resume_campaign':
        await resumeCampaign(userId, a.campaignId!, controls);
        text = `Resumed ${quote(a.subject!)}. Emails continue in their original order.`;
        suggestions = [`How is #${shortId(a.campaignId!)} doing?`, "What's next to send?"];
        context = { campaignId: a.campaignId };
        break;
      case 'cancel_campaign':
        await cancelCampaign(userId, a.campaignId!, controls);
        text = `Cancelled ${quote(a.subject!)}. Its pending emails won’t be sent.`;
        context = { campaignId: a.campaignId };
        break;
      case 'retry_failed': {
        const n = await retryFailed(userId, a.campaignId!, controls);
        text = `Re-queued ${plural(n, 'failed email')} in ${quote(a.subject!)}.`;
        suggestions = [`How is #${shortId(a.campaignId!)} doing?`, "What's next to send?"];
        context = { campaignId: a.campaignId };
        break;
      }
      case 'retry_all_failed': {
        let n = 0;
        for (const cid of p.args.campaignIds as string[]) n += await retryFailed(userId, cid, controls).catch(() => 0);
        text = `Re-queued ${plural(n, 'failed email')}.`;
        suggestions = ["What's next to send?", 'Are we being rate limited?'];
        break;
      }
      case 'retry_email':
        await retryEmail(userId, a.emailId!, controls);
        text = `Re-queued the email to ${a.to}.`;
        context = { emailId: a.emailId };
        break;
      case 'cancel_email':
        await cancelEmail(userId, a.emailId!, controls);
        text = `Cancelled the email to ${a.to}.`;
        break;
      case 'dnc_add': {
        const emails = p.args.emails as string[];
        const created = await deps.prisma.suppressedEmail.createMany({ data: emails.map((email) => ({ userId, email })), skipDuplicates: true });
        // A blocked address must not still receive mail that was already scheduled.
        const queued = await deps.prisma.email.findMany({ where: { userId, toEmail: { in: emails }, status: { in: [...WAITING] } }, select: { id: true }, take: 1000 });
        let cancelled = 0;
        for (const e of queued) if (await cancelEmail(userId, e.id, controls).then(() => true, () => false)) cancelled++;
        text = `Added ${plural(created.count, 'address', 'addresses')} to your do-not-contact list${cancelled ? ` and cancelled ${plural(cancelled, 'scheduled email')} to them` : ''}.`;
        suggestions = ['Show the do-not-contact list'];
        break;
      }
      case 'dnc_remove': {
        const removed = await deps.prisma.suppressedEmail.deleteMany({ where: { userId, email: { in: p.args.emails as string[] } } });
        text = `Removed ${plural(removed.count, 'address', 'addresses')} from your do-not-contact list.`;
        break;
      }
      default:
        throw new AppError(400, 'VALIDATION', 'Unknown action');
    }
    await audit(deps, userId, p.tool, p.args, 'EXECUTED', p.summary);
    return base('confirmed', text, { suggestions, context });
  } catch (err) {
    const message = err instanceof AppError ? err.message : 'Something went wrong';
    if (!(err instanceof AppError)) logger.warn({ err, tool: p.tool }, 'assistant action failed');
    await audit(deps, userId, p.tool, p.args, 'FAILED', `${p.summary} — failed: ${message}`);
    return base('confirm_failed', `I couldn’t do that: ${message}. Nothing was changed.`, { suggestions: ['Give me an overview'] });
  }
}

export async function declineAction(userId: string, id: string, deps: AssistantDeps): Promise<AssistantReply> {
  const raw = await deps.redis.getdel(pendingKey(userId, id));
  if (raw) {
    const p = JSON.parse(raw) as Stored;
    await audit(deps, userId, p.tool, p.args, 'CANCELLED', `Declined: ${p.summary}`);
  }
  return base('declined', 'Okay — I won’t do that. Nothing was changed.', { suggestions: STARTERS.slice(0, 3) });
}

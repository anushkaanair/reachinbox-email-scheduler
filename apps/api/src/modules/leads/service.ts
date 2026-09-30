import type { Prisma, PrismaClient } from '@prisma/client';
import {
  classifyLead,
  domainOf,
  isValidEmail,
  LEAD_REASONS,
  MAX_LEADS_PER_USER,
  MAX_LISTS,
  type CreateLeadList,
  type DomainMail,
  type Lead,
  type LeadCounts,
  type LeadListSummary,
  type LeadPage,
  type LeadReason,
  type LeadStatus,
  type VerifyResult,
} from '@ri/shared';
import { AppError } from '../../lib/errors.js';
import { lookupDomains, type MailResolver } from './dns.js';

const emptyCounts = (): LeadCounts => ({ valid: 0, risky: 0, undeliverable: 0, unknown: 0, unchecked: 0 });

async function countsFor(prisma: PrismaClient, listIds: string[]): Promise<Map<string, LeadCounts>> {
  const out = new Map(listIds.map((id) => [id, emptyCounts()]));
  if (listIds.length === 0) return out;
  const rows = await prisma.listLead.groupBy({ by: ['listId', 'status'], where: { listId: { in: listIds } }, _count: { _all: true } });
  for (const r of rows) {
    const c = out.get(r.listId)!;
    const n = r._count._all;
    if (r.status === 'VALID') c.valid += n;
    else if (r.status === 'RISKY') c.risky += n;
    else if (r.status === 'UNDELIVERABLE') c.undeliverable += n;
    else if (r.status === 'UNKNOWN') c.unknown += n;
    else c.unchecked += n;
  }
  return out;
}

const total = (c: LeadCounts) => c.valid + c.risky + c.undeliverable + c.unknown + c.unchecked;

export async function ownList(prisma: PrismaClient, userId: string, id: string) {
  const list = await prisma.leadList.findFirst({ where: { id, userId } });
  if (!list) throw AppError.notFound('List not found');
  return list;
}

export async function listLists(prisma: PrismaClient, userId: string): Promise<LeadListSummary[]> {
  const lists = await prisma.leadList.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' } });
  const counts = await countsFor(prisma, lists.map((l) => l.id));
  return lists.map((l) => ({ id: l.id, name: l.name, total: total(counts.get(l.id)!), counts: counts.get(l.id)!, updatedAt: l.updatedAt.toISOString() }));
}

export async function summaryOf(prisma: PrismaClient, userId: string, id: string): Promise<LeadListSummary> {
  const l = await ownList(prisma, userId, id);
  const c = (await countsFor(prisma, [id])).get(id)!;
  return { id: l.id, name: l.name, total: total(c), counts: c, updatedAt: l.updatedAt.toISOString() };
}

/** Create a list: addresses are trimmed, lowercased, validated and de-duplicated; the limits are per person. */
export async function createList(prisma: PrismaClient, userId: string, input: CreateLeadList): Promise<LeadListSummary> {
  const seen = new Set<string>();
  const leads: Lead[] = [];
  for (const l of input.leads) {
    const email = l.email.trim().toLowerCase();
    if (!isValidEmail(email) || seen.has(email)) continue;
    seen.add(email);
    leads.push({ email, name: l.name?.trim() || undefined, vars: l.vars });
  }
  if (leads.length === 0) throw new AppError(400, 'VALIDATION', 'No valid email addresses to save');
  if ((await prisma.leadList.count({ where: { userId } })) >= MAX_LISTS) throw new AppError(409, 'CONFLICT', `You can keep up to ${MAX_LISTS} lists. Delete one first.`);
  const existing = await prisma.listLead.count({ where: { list: { userId } } });
  if (existing + leads.length > MAX_LEADS_PER_USER) throw new AppError(409, 'CONFLICT', `Your lists can hold up to ${MAX_LEADS_PER_USER.toLocaleString('en-US')} addresses in total.`);

  const list = await prisma.leadList.create({ data: { userId, name: input.name } });
  for (let i = 0; i < leads.length; i += 1000) {
    await prisma.listLead.createMany({
      data: leads.slice(i, i + 1000).map((l) => ({ listId: list.id, email: l.email, name: l.name ?? null, vars: (l.vars ?? undefined) as Prisma.InputJsonValue | undefined })),
    });
  }
  return summaryOf(prisma, userId, list.id);
}

const STATUS_FILTER = new Set<string>(['VALID', 'RISKY', 'UNDELIVERABLE', 'UNKNOWN', 'UNCHECKED']);
const statusWhere = (status?: string): Prisma.ListLeadWhereInput => (status && STATUS_FILTER.has(status) ? (status === 'UNCHECKED' ? { status: null } : { status }) : {});

export async function leadPage(prisma: PrismaClient, userId: string, id: string, q: { status?: string; cursor?: string; limit: number }): Promise<LeadPage> {
  await ownList(prisma, userId, id);
  const where: Prisma.ListLeadWhereInput = { listId: id, ...statusWhere(q.status) };
  const [rows, count] = await Promise.all([
    prisma.listLead.findMany({ where, orderBy: [{ email: 'asc' }, { id: 'asc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) }),
    prisma.listLead.count({ where }),
  ]);
  const more = rows.length > q.limit;
  const page = more ? rows.slice(0, q.limit) : rows;
  return {
    total: count,
    nextCursor: more ? (page.at(-1)?.id ?? null) : null,
    items: page.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      status: (['VALID', 'RISKY', 'UNDELIVERABLE', 'UNKNOWN'] as const).find((s) => s === r.status) ?? null,
      reason: (LEAD_REASONS as readonly string[]).includes(r.reason ?? '') ? (r.reason as LeadReason) : null,
      suggestion: r.suggestion,
      checkedAt: r.checkedAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Check every address that hasn't been checked yet. Domains are looked up once each (many leads share one), within
 * a time budget; whatever isn't reached stays unchecked and the next call carries on, so this is safe to repeat.
 */
export async function verifyList(prisma: PrismaClient, userId: string, id: string, deps: { resolver?: MailResolver; deadlineMs?: number } = {}): Promise<VerifyResult> {
  await ownList(prisma, userId, id);
  const pending = await prisma.listLead.findMany({ where: { listId: id, status: null }, select: { id: true, email: true } });
  const mail: Map<string, DomainMail> = await lookupDomains(pending.map((p) => domainOf(p.email)), deps.resolver, { deadlineMs: deps.deadlineMs });
  const now = new Date();
  const updates: Prisma.PrismaPromise<unknown>[] = [];
  let checked = 0;
  for (const p of pending) {
    const m = mail.get(domainOf(p.email));
    if (!m) continue; // the time budget ran out before this domain
    const r = classifyLead(p.email, m);
    updates.push(prisma.listLead.update({ where: { id: p.id }, data: { status: r.status, reason: r.reason, suggestion: r.suggestion, checkedAt: now } }));
    checked++;
    if (updates.length >= 200) await prisma.$transaction(updates.splice(0));
  }
  if (updates.length) await prisma.$transaction(updates);
  await prisma.leadList.update({ where: { id }, data: { updatedAt: now } });
  const counts = (await countsFor(prisma, [id])).get(id)!;
  return { checked, remaining: counts.unchecked, counts };
}

export async function removeByStatus(prisma: PrismaClient, userId: string, id: string, status: LeadStatus): Promise<number> {
  await ownList(prisma, userId, id);
  const done = await prisma.listLead.deleteMany({ where: { listId: id, status } });
  if (done.count) await prisma.leadList.update({ where: { id }, data: { updatedAt: new Date() } });
  return done.count;
}

/** The addresses to send to, in the shape Compose wants. By default those found undeliverable are left out. */
export async function recipients(prisma: PrismaClient, userId: string, id: string, opts: { includeUndeliverable?: boolean } = {}): Promise<Lead[]> {
  await ownList(prisma, userId, id);
  const rows = await prisma.listLead.findMany({ where: { listId: id, ...(opts.includeUndeliverable ? {} : { OR: [{ status: null }, { status: { not: 'UNDELIVERABLE' } }] }) }, orderBy: { email: 'asc' } });
  return rows.map((r) => ({ email: r.email, ...(r.name ? { name: r.name } : {}), ...(r.vars && typeof r.vars === 'object' && !Array.isArray(r.vars) ? { vars: r.vars as Record<string, string> } : {}) }));
}

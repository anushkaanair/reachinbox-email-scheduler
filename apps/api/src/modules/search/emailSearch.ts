import type { Client } from '@elastic/elasticsearch';
import type { PrismaClient } from '@prisma/client';
import { HL_CLOSE, HL_OPEN, TAB_STATUSES, htmlToText, type SearchQuery } from '@ri/shared';

const SEARCH_FIELDS = ['toEmail^3', 'toName^2', 'subject^2', 'body', 'senderEmail'];

export type SearchIds = {
  ids: string[];
  highlights: Record<string, Record<string, string[]>>;
  total: number;
  tookMs: number;
  approximate: boolean;
};

const tabOf = (status: string) =>
  (TAB_STATUSES.scheduled as readonly string[]).includes(status)
    ? 'scheduled'
    : (TAB_STATUSES.sent as readonly string[]).includes(status)
      ? 'sent'
      : 'other';

/**
 * Elasticsearch side of email search (GODFATHER §7.2).
 * Postgres stays the source of truth: documents are (re)built from the DB row every time, so
 * indexing is idempotent and order-independent, and a full rebuild is always possible.
 * Queries go through an alias so the physical index can be swapped without downtime.
 */
export class EmailSearch {
  readonly physical: string;

  constructor(
    private readonly es: Client,
    private readonly prisma: PrismaClient,
    readonly alias = 'emails',
  ) {
    this.physical = `${alias}-v1`;
  }

  async ensureIndex(): Promise<void> {
    if (await this.es.indices.existsAlias({ name: this.alias })) return;
    await this.es.indices.create({
      index: this.physical,
      aliases: { [this.alias]: {} },
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        analysis: {
          // "ada.lovelace@acme.io" → ada, lovelace, acme, io — so partial address search works.
          tokenizer: { email_parts: { type: 'pattern', pattern: '[^\\p{L}\\p{N}]+' } },
          analyzer: { email_parts: { type: 'custom', tokenizer: 'email_parts', filter: ['lowercase'] } },
        },
      },
      mappings: {
        dynamic: 'strict',
        properties: {
          id: { type: 'keyword' },
          userId: { type: 'keyword' },
          campaignId: { type: 'keyword' },
          toEmail: { type: 'text', analyzer: 'email_parts', fields: { keyword: { type: 'keyword' } } },
          toName: { type: 'text' },
          senderEmail: { type: 'text', analyzer: 'email_parts', fields: { keyword: { type: 'keyword' } } },
          subject: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
          body: { type: 'text' },
          status: { type: 'keyword' },
          tab: { type: 'keyword' },
          scheduledAt: { type: 'date' },
          nextAttemptAt: { type: 'date' },
          sentAt: { type: 'date' },
          failedAt: { type: 'date' },
        },
      },
    });
  }

  /** Upsert the given emails from Postgres; ids no longer in the DB are removed from the index. */
  async indexEmails(ids: string[], opts: { refresh?: boolean } = {}): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.prisma.email.findMany({
      where: { id: { in: ids } },
      include: { sender: { select: { email: true } } },
    });
    const found = new Set(rows.map((r) => r.id));
    const operations: object[] = [];
    for (const r of rows) {
      operations.push({ index: { _index: this.alias, _id: r.id } }, {
        id: r.id,
        userId: r.userId,
        campaignId: r.campaignId,
        toEmail: r.toEmail,
        toName: r.toName,
        senderEmail: r.sender.email,
        subject: r.subject,
        body: r.bodyIsHtml ? htmlToText(r.body) : r.body,
        status: r.status,
        tab: tabOf(r.status),
        scheduledAt: r.scheduledAt,
        nextAttemptAt: r.nextAttemptAt,
        sentAt: r.sentAt,
        failedAt: r.failedAt,
      });
    }
    for (const id of ids) if (!found.has(id)) operations.push({ delete: { _index: this.alias, _id: id } });

    const res = await this.es.bulk({ operations, refresh: opts.refresh ? 'wait_for' : false });
    if (res.errors) {
      const bad = res.items.filter((i) => {
        const op = i.index ?? i.delete;
        return op?.error && !(i.delete && op.status === 404);
      });
      if (bad.length) throw new Error(`ES bulk failed for ${bad.length} item(s): ${JSON.stringify(bad[0])}`);
    }
    return rows.length;
  }

  /**
   * Tenant-scoped search. Precise first: every word must match, the last one as a prefix
   * (results while typing). Only if that finds nothing do we retry with fuzzy matching
   * (typo tolerance) — so short queries like "load1" stay precise instead of matching "load".
   */
  async search(userId: string, q: SearchQuery): Promise<SearchIds> {
    const exact = await this.run(userId, q, { type: 'bool_prefix' });
    if (exact.total > 0 || q.page > 1) return { ...exact, approximate: false };
    const fuzzy = await this.run(userId, q, { type: 'best_fields', fuzziness: 'AUTO', prefix_length: 1 });
    return { ...fuzzy, tookMs: exact.tookMs + fuzzy.tookMs, approximate: fuzzy.total > 0 };
  }

  private async run(userId: string, q: SearchQuery, match: Record<string, unknown>): Promise<Omit<SearchIds, 'approximate'>> {
    const res = await this.es.search<{ id: string }>({
      index: this.alias,
      from: (q.page - 1) * q.size,
      size: q.size,
      track_total_hits: true,
      _source: false,
      query: {
        bool: {
          filter: [{ term: { userId } }, ...(q.status ? [{ term: { tab: q.status } }] : [])],
          must: [{ multi_match: { query: q.q, fields: SEARCH_FIELDS, operator: 'and', ...match } }],
        },
      },
      sort: ['_score', { scheduledAt: 'desc' }],
      highlight: {
        pre_tags: [HL_OPEN],
        post_tags: [HL_CLOSE],
        fields: {
          toEmail: { number_of_fragments: 0 },
          subject: { number_of_fragments: 0 },
          body: { fragment_size: 120, number_of_fragments: 1 },
        },
      },
    });
    const highlights: SearchIds['highlights'] = {};
    const ids = res.hits.hits.map((h) => {
      const id = h._id!;
      highlights[id] = (h.highlight ?? {}) as Record<string, string[]>;
      return id;
    });
    const total = typeof res.hits.total === 'number' ? res.hits.total : (res.hits.total?.value ?? 0);
    return { ids, highlights, total, tookMs: res.took };
  }

  async refresh(): Promise<void> {
    await this.es.indices.refresh({ index: this.alias });
  }

  /** Tests only. */
  async drop(): Promise<void> {
    await this.es.indices.delete({ index: this.physical, ignore_unavailable: true });
  }
}

/**
 * Rebuilds the Elasticsearch index from Postgres (the source of truth).
 *   npm run reindex -w @ri/api
 */
import { env } from '../src/config/env.js';
import { es } from '../src/lib/elasticsearch.js';
import { prisma } from '../src/lib/prisma.js';
import { EmailSearch } from '../src/modules/search/emailSearch.js';

const search = new EmailSearch(es, prisma, env.ES_INDEX);
await search.ensureIndex();
let cursor: string | undefined;
let total = 0;
for (;;) {
  const rows = await prisma.email.findMany({
    select: { id: true },
    orderBy: { id: 'asc' },
    take: 500,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  if (rows.length === 0) break;
  cursor = rows.at(-1)!.id;
  total += await search.indexEmails(rows.map((r) => r.id));
  process.stdout.write(`\rindexed ${total}`);
}
await search.refresh();
console.log(`\n✅ reindexed ${total} emails into "${env.ES_INDEX}"`);
await prisma.$disconnect();

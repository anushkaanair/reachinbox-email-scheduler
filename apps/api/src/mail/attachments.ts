import type { PrismaClient } from '@prisma/client';

export type FileToSend = { filename: string; contentType: string; content: Buffer };
export type AttachmentLoader = (campaignId: string) => Promise<FileToSend[]>;

/**
 * Every email of a campaign carries the same files, so read them from Postgres once and keep them in memory
 * for the next sends. The cache holds a handful of campaigns at most (each is capped at 10 MB), and a failed
 * load is forgotten so the next attempt tries again.
 */
export function createAttachmentLoader(prisma: PrismaClient, maxCampaigns = 8): AttachmentLoader {
  const cache = new Map<string, Promise<FileToSend[]>>();
  return (campaignId) => {
    const hit = cache.get(campaignId);
    if (hit) return hit;
    const load = prisma.attachment
      .findMany({ where: { campaignId }, orderBy: { createdAt: 'asc' }, select: { fileName: true, contentType: true, data: true } })
      .then((rows) => rows.map((r) => ({ filename: r.fileName, contentType: r.contentType, content: Buffer.from(r.data) })));
    cache.set(campaignId, load);
    load.catch(() => cache.delete(campaignId));
    while (cache.size > maxCampaigns) cache.delete(cache.keys().next().value as string);
    return load;
  };
}

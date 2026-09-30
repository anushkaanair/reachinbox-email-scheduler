import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import type { Logger } from 'pino';
import type { SlackStatus } from '@ri/shared';
import { decrypt, encrypt } from '../../lib/crypto.js';
import type { RateLimitNotice } from '../../queues/queues.js';

export type SlackConfig = {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  webUrl: string;
  jwtSecret: string;
};

export type PostResult = 'sent' | 'skipped_not_connected' | 'skipped_invalid';

const SCOPES = 'incoming-webhook,chat:write';
const STATE_PURPOSE = 'slack-oauth';
/** Webhook responses meaning "this webhook will never work again" → user must reconnect. */
const DEAD_WEBHOOK = /no_service|invalid_token|channel_not_found|channel_is_archived|action_prohibited|no_team/;

type OAuthAccess = {
  ok: boolean;
  error?: string;
  access_token?: string;
  team?: { id: string; name: string };
  incoming_webhook?: { url: string; channel: string; channel_id: string };
};

/**
 * Per-user Slack integration (GODFATHER §7.3). Tokens are read at send time, so connecting,
 * disconnecting or reconnecting takes effect immediately — no redeploy, no restart.
 */
export class SlackService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cfg: SlackConfig,
    private readonly logger: Logger,
    private readonly http: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.cfg.clientId && this.cfg.clientSecret && this.cfg.redirectUri);
  }

  /** Signed, short-lived state binds the callback to the user (the callback arrives via the
   *  public tunnel URL, where the localhost session cookie isn't sent). */
  authorizeUrl(userId: string): string {
    const state = jwt.sign({ sub: userId, n: randomBytes(8).toString('hex'), p: STATE_PURPOSE }, this.cfg.jwtSecret, {
      expiresIn: '10m',
    });
    const qs = new URLSearchParams({
      client_id: this.cfg.clientId!,
      scope: SCOPES,
      redirect_uri: this.cfg.redirectUri!,
      state,
    });
    return `https://slack.com/oauth/v2/authorize?${qs}`;
  }

  verifyState(state: string): string | null {
    try {
      const p = jwt.verify(state, this.cfg.jwtSecret, { algorithms: ['HS256'] });
      return typeof p === 'object' && p.p === STATE_PURPOSE && typeof p.sub === 'string' ? p.sub : null;
    } catch {
      return null;
    }
  }

  /** Exchanges the OAuth code and stores the (encrypted) webhook + bot token for the user. */
  async completeOAuth(userId: string, code: string): Promise<void> {
    const res = await this.http('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId!,
        client_secret: this.cfg.clientSecret!,
        code,
        redirect_uri: this.cfg.redirectUri!,
      }),
    });
    const data = (await res.json()) as OAuthAccess;
    if (!data.ok || !data.incoming_webhook || !data.team) {
      throw new Error(`Slack OAuth failed: ${data.error ?? 'missing incoming_webhook'}`);
    }
    const fields = {
      teamId: data.team.id,
      teamName: data.team.name,
      channelId: data.incoming_webhook.channel_id,
      channelName: data.incoming_webhook.channel,
      webhookUrlEnc: encrypt(data.incoming_webhook.url),
      botTokenEnc: data.access_token ? encrypt(data.access_token) : null,
      isValid: true,
    };
    await this.prisma.slackConnection.upsert({ where: { userId }, create: { userId, ...fields }, update: fields });
    this.logger.info({ userId, team: data.team.name, channel: data.incoming_webhook.channel }, 'slack connected');
  }

  async status(userId: string): Promise<SlackStatus> {
    const c = await this.prisma.slackConnection.findUnique({ where: { userId } });
    return {
      configured: this.configured,
      connected: Boolean(c),
      valid: Boolean(c?.isValid),
      teamName: c?.teamName ?? null,
      channelName: c?.channelName ?? null,
      connectedAt: c?.updatedAt.toISOString() ?? null,
    };
  }

  async disconnect(userId: string): Promise<void> {
    const c = await this.prisma.slackConnection.findUnique({ where: { userId } });
    if (!c) return;
    if (c.botTokenEnc) {
      // Best effort: also uninstall the token on Slack's side.
      await this.http('https://slack.com/api/auth.revoke', {
        method: 'POST',
        headers: { Authorization: `Bearer ${decrypt(c.botTokenEnc)}` },
      }).catch((err) => this.logger.warn({ err }, 'slack auth.revoke failed (ignored)'));
    }
    await this.prisma.slackConnection.deleteMany({ where: { userId } });
    this.logger.info({ userId }, 'slack disconnected');
  }

  /**
   * Posts to the user's channel. Not connected → skipped (never throws). A permanently dead
   * webhook → marked invalid (UI asks to reconnect). Transient failures throw → the
   * notifications queue retries with backoff.
   */
  async post(userId: string, message: { text: string; blocks?: unknown[] }): Promise<PostResult> {
    const c = await this.prisma.slackConnection.findUnique({ where: { userId } });
    if (!c) return 'skipped_not_connected';
    if (!c.isValid) return 'skipped_invalid';

    const res = await this.http(decrypt(c.webhookUrlEnc), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (res.ok) return 'sent';

    const body = await res.text().catch(() => '');
    if ([403, 404, 410].includes(res.status) || DEAD_WEBHOOK.test(body)) {
      await this.prisma.slackConnection.update({ where: { userId }, data: { isValid: false } });
      this.logger.warn({ userId, status: res.status, body }, 'slack webhook rejected → marked invalid');
      return 'skipped_invalid';
    }
    throw new Error(`Slack webhook HTTP ${res.status}: ${body}`);
  }

  sendTest(userId: string): Promise<PostResult> {
    return this.post(userId, {
      text: '✅ ReachInbox is connected',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '✅ ReachInbox is connected' } },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: "You'll get a message here *the moment* any of your senders hits its hourly sending limit.",
          },
        },
      ],
    });
  }

  notifySenderPaused(n: { senderEmail: string; userId: string; until: string; reason: string }): Promise<PostResult> {
    const until = new Date(n.until).toUTCString().replace(' GMT', ' UTC');
    return this.post(n.userId, {
      text: `⏸ Sender paused: ${n.senderEmail} until ${until}. ${n.reason}`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '⏸ A sender was paused' } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Sender*\n${n.senderEmail}` },
            { type: 'mrkdwn', text: `*Paused until*\n${until}` },
          ],
        },
        { type: 'section', text: { type: 'mrkdwn', text: `*Why:* ${n.reason}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Its emails wait (nothing is dropped) and resume automatically, or resume it from the Senders page.' }] },
      ],
    });
  }

  notifyCampaignPaused(n: { campaignId: string; userId: string; subject: string; bounceRate: number; threshold: number; bounced: number; attempts: number }): Promise<PostResult> {
    return this.post(n.userId, {
      text: `⏸ Campaign paused: “${n.subject}” — ${n.bounceRate}% bounced (limit ${n.threshold}%).`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '⏸ Campaign paused to protect your senders' } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Campaign*\n${n.subject.slice(0, 120)}` },
            { type: 'mrkdwn', text: `*Bounce rate*\n${n.bounceRate}% (${n.bounced} of ${n.attempts}) — limit ${n.threshold}%` },
          ],
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Nothing was dropped. Clean the lead list, then resume the campaign from the Campaigns page.' }] },
      ],
    });
  }

  notifyRateLimit(n: RateLimitNotice): Promise<PostResult> {
    const scopeLabel = { sender: 'Per-sender hourly limit', global: 'Global hourly limit', campaign: 'Campaign hourly limit', daily: 'Warm-up daily limit' }[n.scope];
    const resumes = new Date(n.retryAt).toUTCString().replace(' GMT', ' UTC');
    return this.post(n.userId, {
      text: `🚦 Hourly limit reached for ${n.senderEmail} (${n.limit}/hour). Remaining emails resume at ${resumes}.`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🚦 Hourly sending limit reached' } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Sender*\n${n.senderEmail}` },
            { type: 'mrkdwn', text: `*Limit*\n${scopeLabel}: ${n.limit}` },
            { type: 'mrkdwn', text: `*Window started*\n${new Date(n.windowStart).toUTCString().replace(' GMT', ' UTC')}` },
            { type: 'mrkdwn', text: `*Resumes at*\n${resumes}` },
          ],
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: 'Nothing was dropped: deferred emails keep their order and send automatically.' },
          ],
        },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Open dashboard' }, url: `${this.cfg.webUrl}/dashboard/scheduled` },
          ],
        },
      ],
    });
  }
}

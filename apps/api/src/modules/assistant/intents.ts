import type { AssistantContext, EmailStatus } from '@ri/shared';

/**
 * Rule-based understanding of what the user typed. No external service: a message is normalised,
 * entities (addresses, #ids, campaign names, time ranges) are pulled out, and an ordered list of
 * rules picks ONE intent. Deterministic and side-effect free, so it can be tested exhaustively.
 *
 * Nothing in this file touches the database — campaign names arrive as data (CampaignRef[]) and are
 * only ever used to *match*, never interpreted as instructions.
 */

export type CampaignRef = { id: string; subject: string; status: string };

export type RangeSpec =
  | { kind: 'all' }
  | { kind: 'today' }
  | { kind: 'yesterday' }
  | { kind: 'hours'; n: number }
  | { kind: 'days'; n: number };

export type CampaignTarget =
  | { kind: 'one'; ref: CampaignRef; via: 'id' | 'name' | 'context' | 'latest' }
  | { kind: 'ambiguous'; refs: CampaignRef[] }
  | { kind: 'none' };

export type CampaignFilter = 'active' | 'paused' | 'completed' | 'cancelled';
export type CampaignAction = 'pause' | 'resume' | 'cancel' | 'retry_failed';

export type Intent =
  | { kind: 'greeting' | 'thanks' | 'help' | 'health' | 'slack' | 'next_sends' | 'rate_limits' | 'sender_usage' | 'dnc_count' | 'eta_all' | 'retry_all_failed' | 'failed_list' | 'unknown' }
  | { kind: 'overview'; range: RangeSpec }
  | { kind: 'count'; statuses: EmailStatus[] | null; label: string; range: RangeSpec }
  | { kind: 'failure_reasons'; range: RangeSpec }
  | { kind: 'campaigns_list'; filter?: CampaignFilter; countOnly: boolean }
  | { kind: 'campaign_report'; target: CampaignTarget; asks: 'finish' | 'status' }
  | { kind: 'email_lookup'; email: string }
  | { kind: 'search'; term: string }
  | { kind: 'need_term' }
  | { kind: 'navigate'; to: string; label: string; external?: boolean }
  | { kind: 'export'; scope: 'failed' | 'sent' | 'scheduled' | 'all'; target: CampaignTarget }
  | { kind: 'campaign_action'; action: CampaignAction; target: CampaignTarget }
  | { kind: 'email_action'; action: 'retry' | 'cancel'; email: string }
  | { kind: 'dnc_add' | 'dnc_remove' | 'dnc_check'; emails: string[] }
  | { kind: 'need_emails'; forAction: 'add' | 'remove' | 'check' };

// ── text helpers ─────────────────────────────────────────────────────────────

const EMAIL_IN_TEXT = /[^\s@<>()[\],;:"']+@[^\s@<>()[\],;:"']+\.[A-Za-z]{2,}/g;

export const extractEmails = (message: string): string[] => {
  const seen = new Set<string>();
  for (const m of message.matchAll(EMAIL_IN_TEXT)) seen.add(m[0].replace(/[.,;:!?)]+$/, '').toLowerCase());
  return [...seen];
};

/** lower-case, no apostrophes, punctuation → spaces (keeps @ # . - _ for addresses and ids). */
export const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9@#._\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const STOP = new Set(
  (
    'a an the of for to my me i you we our your and or but is are was were be been am do does did can could would should will ' +
    'it its this that these those there here in on at by from with about into onto up down out off over than then so as if ' +
    'how what when where which who why whats hows please pls show tell give get see let lets want need like just also ' +
    'campaign campaigns email emails mail mails message messages send sending sent all any some every ' +
    'pause hold stop resume unpause continue restart cancel abort kill retry resend requeue ' +
    'status progress doing going report stats stat finish done complete end ' +
    'latest newest recent last most one ' +
    // Command vocabulary must never be mistaken for part of a campaign's name.
    'export download csv spreadsheet excel open list find search look lookup failed fail failing failure failures errors error ' +
    'pending waiting scheduled queued deferred block blocked unblock add remove put count total number many much sender senders ' +
    'limit limits slack analytics settings page today yesterday week month hours hour days day ago active paused running ' +
    'completed cancelled canceled next upcoming'
  ).split(' '),
);

const words = (s: string) => normalize(s).split(' ').map((w) => w.replace(/^[.\-_]+|[.\-_]+$/g, '')).filter(Boolean);

/** Words in a campaign subject worth matching on ({{merge_tags}} and filler removed). */
const subjectTokens = (subject: string) => words(subject.replace(/\{\{[^}]*\}\}/g, ' ')).filter((w) => w.length >= 3 && !STOP.has(w));

const has = (norm: string, re: RegExp) => re.test(norm);

// ── entity extraction ────────────────────────────────────────────────────────

export function parseRange(norm: string): RangeSpec {
  if (has(norm, /\byesterday\b/)) return { kind: 'yesterday' };
  if (has(norm, /\btoday\b|\bso far today\b|\bthis morning\b/)) return { kind: 'today' };
  if (has(norm, /\b(last|past) hour\b/)) return { kind: 'hours', n: 1 };
  const m = norm.match(/\b(?:last|past) (\d{1,3}) (hour|hours|hr|hrs|day|days|week|weeks)\b/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!;
    if (unit.startsWith('h')) return { kind: 'hours', n };
    if (unit.startsWith('w')) return { kind: 'days', n: n * 7 };
    return { kind: 'days', n };
  }
  if (has(norm, /\b(this|past|last) week\b/)) return { kind: 'days', n: 7 };
  if (has(norm, /\b(this|past|last) month\b/)) return { kind: 'days', n: 30 };
  if (has(norm, /\b(this|past|last) 24 ?(hours|hrs|h)\b/)) return { kind: 'hours', n: 24 };
  return { kind: 'all' };
}

export function parseStatuses(norm: string): { statuses: EmailStatus[]; label: string } | null {
  if (has(norm, /\b(deferred|rate ?limited|throttled)\b/)) return { statuses: ['RATE_LIMITED'], label: 'deferred by a rate limit' };
  if (has(norm, /\b(fail|failed|failing|failure|failures|errored|errors?|bounced|bounces?)\b/)) return { statuses: ['FAILED'], label: 'failed' };
  if (has(norm, /\b(cancelled|canceled)\b/)) return { statuses: ['CANCELLED'], label: 'cancelled' };
  if (has(norm, /\b(sent|delivered|went out|gone out)\b/)) return { statuses: ['SENT'], label: 'sent' };
  if (has(norm, /\b(pending|waiting|outstanding|remaining|unsent|left to send|in the queue|in queue|queued up)\b/))
    return { statuses: ['SCHEDULED', 'RATE_LIMITED', 'SENDING'], label: 'still waiting to go out' };
  if (has(norm, /\b(scheduled|queued|upcoming)\b/)) return { statuses: ['SCHEDULED'], label: 'scheduled' };
  if (has(norm, /\bsending\b/)) return { statuses: ['SENDING'], label: 'sending right now' };
  return null;
}

/** Which campaign does the message mean? #id → name match → "latest" → "it" (context). */
export function resolveCampaign(message: string, norm: string, ctx: AssistantContext | undefined, campaigns: CampaignRef[]): CampaignTarget {
  const hash = message.match(/#([0-9a-f-]{4,36})/i)?.[1]?.toLowerCase();
  if (hash) {
    const hit = campaigns.filter((c) => c.id.toLowerCase().startsWith(hash));
    if (hit.length === 1) return { kind: 'one', ref: hit[0]!, via: 'id' };
    if (hit.length > 1) return { kind: 'ambiguous', refs: hit };
  }

  const msgTokens = words(message.replace(EMAIL_IN_TEXT, ' ')).filter((w) => w.length >= 3 && !STOP.has(w));
  if (msgTokens.length > 0) {
    const scored = campaigns
      .map((c) => {
        const subj = subjectTokens(c.subject);
        const score = msgTokens.filter((t) => subj.some((s) => s === t || (t.length >= 4 && s.startsWith(t)))).length;
        return { c, score };
      })
      .filter((x) => x.score > 0);
    if (scored.length > 0) {
      const best = Math.max(...scored.map((x) => x.score));
      const top = scored.filter((x) => x.score === best).map((x) => x.c);
      return top.length === 1 ? { kind: 'one', ref: top[0]!, via: 'name' } : { kind: 'ambiguous', refs: top };
    }
  }

  // The user typed a campaign's whole title (even one made only of ordinary words).
  const titled = campaigns.filter((c) => {
    const t = normalize(c.subject.replace(/\{\{[^}]*\}\}/g, ' '));
    return t.length >= 4 && norm.includes(t);
  });
  if (titled.length > 0) {
    const longest = Math.max(...titled.map((c) => c.subject.length));
    const best = titled.filter((c) => c.subject.length === longest);
    return best.length === 1 ? { kind: 'one', ref: best[0]!, via: 'name' } : { kind: 'ambiguous', refs: best };
  }

  if (has(norm, /\b(latest|newest|most recent|last campaign|last one|recent campaign)\b/) && campaigns[0]) {
    return { kind: 'one', ref: campaigns[0], via: 'latest' };
  }
  if (ctx?.campaignId && has(norm, /\b(it|this|that|them|the campaign|this campaign|that campaign)\b/)) {
    const ref = campaigns.find((c) => c.id === ctx.campaignId);
    if (ref) return { kind: 'one', ref, via: 'context' };
  }
  return { kind: 'none' };
}

const PAGES: { re: RegExp; to: string; label: string; external?: boolean }[] = [
  { re: /\b(do ?not ?contact|dnc|block ?list|suppression)\b/, to: '/settings#do-not-contact', label: 'Do-not-contact list' },
  { re: /\b(bull ?board|queue dashboard|queues dashboard)\b/, to: '/admin/queues', label: 'Queue dashboard', external: true },
  { re: /\b(analytics|charts?|graphs?)\b/, to: '/analytics', label: 'Analytics' },
  { re: /\b(settings|integrations?|preferences)\b/, to: '/settings', label: 'Settings' },
  { re: /\b(compose|new email|new campaign|write an email|create (a )?campaign)\b/, to: '/compose', label: 'Compose' },
  { re: /\bcampaigns\b/, to: '/campaigns', label: 'Campaigns' },
  { re: /\bsent\b/, to: '/dashboard/sent', label: 'Sent emails' },
  { re: /\b(scheduled|schedule|upcoming)\b/, to: '/dashboard/scheduled', label: 'Scheduled emails' },
  { re: /\b(dashboard|home)\b/, to: '/dashboard/scheduled', label: 'Dashboard' },
];

// ── the rules ────────────────────────────────────────────────────────────────

export function parseIntent(message: string, ctx: AssistantContext | undefined, campaigns: CampaignRef[]): Intent {
  const norm = normalize(message);
  const emails = extractEmails(message);
  const range = parseRange(norm);
  const st = parseStatuses(norm);
  const target = () => resolveCampaign(message, norm, ctx, campaigns);

  // 1. small talk
  if (has(norm, /^(hi|hello|hey|yo|hiya|good (morning|afternoon|evening))( there)?$/)) return { kind: 'greeting' };
  if (has(norm, /\b(thanks|thank you|thx|cheers|great thanks)\b/) && norm.split(' ').length <= 5) return { kind: 'thanks' };
  if (has(norm, /\b(help|what can you do|what do you do|commands|how do i use|what can i ask|capabilities)\b/)) return { kind: 'help' };

  // 2. do-not-contact list
  const dncWords = has(norm, /\b(do ?not ?contact|dnc|block ?list|blacklist|suppress(ed|ion)?|opt ?outs?|unsubscribed?)\b/);
  const blockedWord = has(norm, /\b(blocked|suppressed|blacklisted|unsubscribed)\b/);
  if (has(norm, /\bhow many\b/) && (dncWords || blockedWord)) return { kind: 'dnc_count' };
  if (has(norm, /\b(remove|unblock|unsuppress|take off|allow|whitelist|clear)\b/) && (emails.length > 0 || dncWords)) {
    return emails.length ? { kind: 'dnc_remove', emails } : { kind: 'need_emails', forAction: 'remove' };
  }
  // "do not contact LIST" is a noun here, not the verb "list".
  const verbs = norm.replace(/(do ?not ?contact|block|black|suppression) ?list/g, 'dnc');
  if (emails.length > 0 && has(norm, /\b(add|put|block|suppress|blacklist|blocklist|unsubscribe|exclude|never (email|contact))\b/)) return { kind: 'dnc_add', emails };
  if (emails.length === 0 && dncWords && has(norm, /\b(add|put|block|suppress|unsubscribe|exclude)\b/) && !has(verbs, /\b(who|which|list|show|see|view)\b/)) {
    return { kind: 'need_emails', forAction: 'add' };
  }
  if (emails.length === 0 && (dncWords || blockedWord) && has(verbs, /\b(who|which|list|show|see|view|whos)\b/)) return { kind: 'dnc_count' };
  if (has(norm, /\b(is|are|check|am i|can i)\b/) && (dncWords || blockedWord) && emails.length > 0) return { kind: 'dnc_check', emails };
  if (has(norm, /\b(is|are|check)\b/) && (dncWords || blockedWord) && emails.length === 0) return { kind: 'need_emails', forAction: 'check' };

  // 3. anything about a specific address
  if (emails.length > 0) {
    const email = emails[0]!;
    if (has(norm, /\b(retry|resend|requeue|try again|send again)\b/)) return { kind: 'email_action', action: 'retry', email };
    if (has(norm, /\b(cancel|abort|kill|unschedule)\b/)) return { kind: 'email_action', action: 'cancel', email };
    return { kind: 'email_lookup', email };
  }

  // 4. commands on campaigns
  const verb: CampaignAction | null = has(norm, /\b(resume|unpause|continue|restart|start again)\b/)
    ? 'resume'
    : has(norm, /\b(pause|hold|stop|halt)\b/) && !has(norm, /\bstopped\b/)
      ? 'pause'
      : has(norm, /\b(cancel|abort|kill)\b/)
        ? 'cancel'
        : has(norm, /\b(retry|resend|requeue|try again|send again)\b/)
          ? 'retry_failed'
          : null;
  if (verb) {
    const t = target();
    if (verb === 'retry_failed' && t.kind === 'none') {
      // "retry all failed" / "retry the failed ones" with no campaign named → across every campaign
      return { kind: 'retry_all_failed' };
    }
    return { kind: 'campaign_action', action: verb, target: t };
  }

  // 5. navigation (a bare page name like "analytics" or "show me settings" also counts)
  const bare = norm.match(/^(?:show me |show |view |see |open |go to |take me to )?(?:the |my )?(analytics|charts|settings|integrations|compose|new campaign|queue dashboard|bull board)(?: page)?$/);
  if (bare) {
    const page = PAGES.find((p) => p.re.test(bare[1]!));
    if (page) return { kind: 'navigate', to: page.to, label: page.label, external: page.external };
  }
  if (has(norm, /\b(open|go to|goto|take me to|navigate( to)?|switch to|jump to|bring up|head to)\b/) || has(norm, /\bpage\b/)) {
    const page = PAGES.find((p) => p.re.test(norm));
    if (page) return { kind: 'navigate', to: page.to, label: page.label, external: page.external };
  }

  // 6. exports
  if (has(norm, /\b(export|download|csv|spreadsheet|excel)\b/)) {
    const scope = has(norm, /\bfail/) ? 'failed' : has(norm, /\bsent\b/) ? 'sent' : has(norm, /\b(scheduled|pending|upcoming)\b/) ? 'scheduled' : 'all';
    return { kind: 'export', scope, target: target() };
  }

  // 7. explicit search
  const searchVerb = norm.match(/\b(find|search( for)?|look for|lookup|look up|grep)\b\s*(.*)$/);
  if (searchVerb && !has(norm, /\b(campaigns?|sender|senders)\b/)) {
    const quoted = message.match(/["“']([^"”']{2,80})["”']/)?.[1];
    const rest = quoted ?? (searchVerb[3] ?? '');
    const term = words(rest)
      .filter((w) => !STOP.has(w) && !['about', 'regarding', 'containing', 'mentioning', 'named', 'called', 'related'].includes(w))
      .join(' ');
    return term ? { kind: 'search', term } : { kind: 'need_term' };
  }

  // 8. specific reports
  if (has(norm, /\b(rate ?limit(ed|s)?|ratelimit\w*|throttl\w*|deferred|limit reached|hit (the |their |its |a )?limit|hitting (the |their |its |a )?limit|over (the |their |its )?limit)\b/)) return { kind: 'rate_limits' };
  if (has(norm, /\b(sender|senders|mailbox|mailboxes|accounts?|inboxes)\b/) && (has(norm, /\b(limit|limits|quota|usage|used|capacity|remaining|left|closest|busiest|near|nearly|full|health|healthy|status)\b/) || has(norm, /\bwhich (sender|mailbox|account)\b/))) {
    return { kind: 'sender_usage' };
  }
  if (has(norm, /\bslack\b/)) return { kind: 'slack' };
  if (has(norm, /\b(whats next|what is next|next (email|send|one|up)|upcoming sends?|coming up|going out next)\b/)) return { kind: 'next_sends' };

  // 9. counting and failures
  if (has(norm, /\b(how many|number of|count of|total)\b/)) {
    if (has(norm, /\bcampaigns?\b/)) return { kind: 'campaigns_list', filter: campaignFilter(norm), countOnly: true };
    return { kind: 'count', statuses: st?.statuses ?? null, label: st?.label ?? 'in total', range };
  }
  if ((has(norm, /\bwhy\b/) && has(norm, /\b(fail|failed|failing|failure|errors?|bounce)\w*/)) || has(norm, /\b(fail|failure|error)\w* (reasons?|causes?|breakdown)\b/) || has(norm, /\b(reasons?|causes?) (for|of) (the )?(fail|errors?)/)) {
    return { kind: 'failure_reasons', range };
  }
  if (has(norm, /\b(fail|failed|failing|failure|failures|errored)\b/)) return { kind: 'failed_list' };

  // 10. campaigns
  const t = target();
  const asksFinish = has(norm, /\b(when|how long|eta|finish|finished|finishing|done|complete|completed|end|ends)\b/);
  if (t.kind !== 'none' && !has(norm, /\b(list|all campaigns)\b/)) return { kind: 'campaign_report', target: t, asks: asksFinish ? 'finish' : 'status' };
  // "how is the unicorn campaign doing?" — a single campaign was meant but none matches: say so.
  if (has(norm, /\bcampaign\b/) && !has(norm, /\bcampaigns\b/) && (asksFinish || has(norm, /\b(how is|hows|doing|going|progress|status|report|stats?)\b/))) {
    return { kind: 'campaign_report', target: t, asks: asksFinish ? 'finish' : 'status' };
  }
  if (has(norm, /\bcampaigns?\b/)) {
    if (asksFinish && t.kind === 'none' && has(norm, /\b(when|how long|eta)\b/)) return { kind: 'eta_all' };
    return { kind: 'campaigns_list', filter: campaignFilter(norm), countOnly: false };
  }
  if ((asksFinish && has(norm, /\b(when|how long|eta)\b/)) || has(norm, /\b(finish|completion|end|done) time\b|\beta\b/)) return { kind: 'eta_all' };

  // 11. system health
  if (has(norm, /\b(health|healthy|system|redis|postgres|database|elasticsearch|search (is )?(up|down)|queue|queues|worker|workers|backlog|backed up|outage|all good|everything (ok|okay|fine|working)|is it working|working ok)\b/)) {
    return { kind: 'health' };
  }

  // 12. overview / generic
  if (has(norm, /\b(stats|statistics|numbers|metrics|figures)\b/) || has(norm, /\bhow are (the |my |our )?(emails|things|campaigns|sends) (doing|going)\b/) || has(norm, /\b(did|have|has|were)\b.*\b(go out|went out|gone out|get sent|been sent|send ok|sending ok)\b/)) {
    return { kind: 'overview', range };
  }
  if (has(norm, /\b(overview|summary|summarize|recap|status|how are things|how is it going|hows it going|whats happening|whats going on|what happened|dashboard|report|update me|catch me up|anything|news)\b/) || st === null && range.kind !== 'all') {
    return { kind: 'overview', range };
  }
  if (st) return { kind: 'count', statuses: st.statuses, label: st.label, range };

  return { kind: 'unknown' };
}

function campaignFilter(norm: string): CampaignFilter | undefined {
  if (has(norm, /\b(active|running|live|ongoing)\b/)) return 'active';
  if (has(norm, /\bpaused\b/)) return 'paused';
  if (has(norm, /\b(completed|finished|done)\b/)) return 'completed';
  if (has(norm, /\b(cancelled|canceled)\b/)) return 'cancelled';
  return undefined;
}

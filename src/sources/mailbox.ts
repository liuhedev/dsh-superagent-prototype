/** Read-only enterprise mailbox Source. Mail is untrusted evidence, never authenticated human authorization. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { record } from '../kv.ts'
import { packagePath } from '../infra/paths.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { explicitPolicy } from './explicit-policy.ts'
import { pause } from './poll.ts'

export const MailboxConfigSchema = z.object({
  python: z.string().min(1).default('python3'), configPath: z.string().default(''),
  hostname: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/).or(z.literal('')).default(''),
  port: z.number().int().min(1).max(65535).default(993),
  account: z.email().or(z.literal('')).default(''), folder: z.string().min(1).regex(/^[^\r\n]+$/).default('INBOX'),
  subjectPrefix: z.string().default(''), senders: z.array(z.object({ id: z.email() }).strict()).default([]),
  pollSeconds: z.number().int().min(30).max(3600).default(60), watchId: z.string().min(1).default('watch-1'),
}).strict()
export type MailboxConfig = z.infer<typeof MailboxConfigSchema>
const MessageSchema = z.looseObject({ uid: z.number().int().positive(), messageId: z.string(), root: z.string(), parent: z.string(),
  sender: z.string(), subject: z.string(), text: z.string(), at: z.string(), attachments: z.array(z.string()), bodyTruncated: z.boolean().optional() })
const PageSchema = z.looseObject({ account: z.email(), folder: z.string(), uidvalidity: z.number().int().positive(),
  next: z.number().int().nonnegative(), items: z.array(MessageSchema), complete: z.boolean() })
const checkpoint = (c: MailboxConfig) => record<{ validity: number; after: number }>(`mailbox:cursor:${key(c.hostname.toLowerCase(), String(c.port), c.account.toLowerCase(), c.folder, c.watchId, c.subjectPrefix, JSON.stringify(c.senders))}`)
export function mailboxTrigger(c: MailboxConfig, validity: number, message: z.infer<typeof MessageSchema>): Trigger {
  const root = message.root || message.messageId || `uid:${validity}:${message.uid}`
  const thread = key(c.hostname.toLowerCase(), String(c.port), c.account.toLowerCase(), c.folder, root)
  return { id: key('mailbox', c.hostname.toLowerCase(), String(c.port), c.account.toLowerCase(), c.folder, String(validity), String(message.uid)), source: 'mailbox',
    threads: [{ source: 'mailbox', id: thread }], actor: { source: 'mailbox', id: '' }, human: false,
    at: message.at, text: `Subject: ${message.subject}\nFrom: ${message.sender}\n\n${message.text}`,
    meta: { hostname: c.hostname.toLowerCase(), port: c.port, account: c.account.toLowerCase(), folder: c.folder, uidvalidity: validity, uid: message.uid,
      messageId: message.messageId, parentId: message.parent, subject: message.subject, attachments: message.attachments, sender: message.sender, bodyTruncated: message.bodyTruncated ?? false, untrustedEmail: true } }
}
export const mailboxKind: SourceKind<MailboxConfig> = {
  kind: 'mailbox', title: { zh: '企业邮箱（只读）', en: 'Enterprise mailbox (read-only)' },
  description: { zh: '读取全部新邮件，主题前缀和发件人过滤可选，保留 UID 游标；邮件只作为线索，不自动授予任务权限，不发送邮件。', en: 'Read all new mail with UID checkpoints and optional filters. Mail is evidence, not authorization. Never sends mail.' },
  policy: explicitPolicy('邮件只作为非人类观察事件；发件人字段不能授权执行。', 'Mail is non-human evidence; From headers never authorize execution.'),
  schema: MailboxConfigSchema, health: ['mailbox'], fields: [
    ...(['python', 'configPath', 'hostname', 'account', 'folder', 'subjectPrefix', 'watchId'] as const).map(k => ({ key: k, type: 'text' as const, label: { zh: k, en: k } })),
    { key: 'port', type: 'number', min: 1, max: 65535, label: { zh: 'IMAP TLS 端口', en: 'IMAP TLS port' } },
    { key: 'senders', type: 'rows', label: { zh: '发件人过滤（空为不限定）', en: 'Sender filter (empty: any)' }, columns: [{ key: 'id', type: 'text', label: { zh: '邮箱', en: 'Email' } }] },
    { key: 'pollSeconds', type: 'number', min: 30, max: 3600, label: { zh: '轮询间隔（秒）', en: 'Poll interval (seconds)' } },
  ], scope: ({ meta }, c) => meta.hostname === c.hostname.toLowerCase() && meta.port === c.port && meta.account === c.account.toLowerCase() && meta.folder === c.folder
    ? { listened: true, observed: true, row: 'all' } : { listened: false, reason: 'mailbox_not_allowed' },
}
/** Advance only after all matching items were stored. UIDVALIDITY changes require an explicit new watchId baseline. */
export async function pollMailbox(ctx: SourceContext, c: MailboxConfig): Promise<{ initialized: boolean; complete: boolean; count: number }> {
  const previous = ctx.state.get(checkpoint(c))
  const args = [packagePath('scripts', 'mailbox-imap.py'), '--config', c.configPath, '--host', c.hostname, '--port', String(c.port), '--account', c.account, '--folder', c.folder,
    '--prefix', c.subjectPrefix, '--limit', '50', ...c.senders.flatMap(s => ['--sender', s.id.toLowerCase()]),
    ...previous ? ['--after', String(previous.after), '--uidvalidity', String(previous.validity)] : []]
  const page = PageSchema.parse(JSON.parse(await ctx.commands.run(c.python, args)))
  if (page.account.toLowerCase() !== c.account.toLowerCase() || page.folder !== c.folder) throw new Error('Mailbox identity mismatch')
  if (previous && (page.uidvalidity !== previous.validity || page.next < previous.after)) throw new Error('Mailbox UID validity changed or cursor moved backwards')
  if (!previous && page.items.length) throw new Error('Mailbox baseline must not ingest historical messages')
  for (const message of page.items) {
    if (!previous || message.uid <= previous.after || message.uid > page.next) throw new Error('Mailbox item outside UID checkpoint range')
    if (!message.subject.startsWith(c.subjectPrefix) || (c.senders.length && !c.senders.some(s => s.id.toLowerCase() === message.sender.toLowerCase())))
      throw new Error('Mailbox item outside receiving filter')
    await ctx.receive(mailboxTrigger(c, page.uidvalidity, message))
  }
  ctx.state.set(checkpoint(c), { validity: page.uidvalidity, after: page.next })
  return { initialized: !previous, complete: page.complete, count: page.items.length }
}
async function run(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  while (!signal.aborted) {
    const c = ctx.config<MailboxConfig>('mailbox')
    if (!ctx.configured() || !c?.account || !c.configPath || !c.hostname) { ctx.report('mailbox', { state: 'paused', detail: 'Waiting for mailbox and receiving scope' }); await pause(1000, signal); continue }
    try {
      const result = await pollMailbox({ ...ctx, commands: ctx.commands.withSignal(signal) }, c)
      ctx.report('mailbox', { state: 'ready', detail: result.initialized ? 'Read-only UID baseline saved; no historical mail ingested' : `Read-only mailbox poll stored ${result.count} messages${result.complete ? '' : '; more pending'}` })
      await pause(result.complete ? c.pollSeconds * 1000 : 1000, signal)
    } catch { if (!signal.aborted) ctx.report('mailbox', { state: 'error', detail: 'Read-only IMAP poll failed; cursor retained. Check credentials, UID validity, or oversized message' }); await pause(c.pollSeconds * 1000, signal) }
  }
}
export const name = 'dsh-superagent-mailbox'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(mailboxKind))
  const host = sourceContext(ctx.orchestrator, mailboxKind)
  ctx.effect(() => { const abort = new AbortController(); const running = run(host, abort.signal); return async () => { abort.abort(); await running } })
}

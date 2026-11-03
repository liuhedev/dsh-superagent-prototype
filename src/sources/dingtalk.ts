/** Optional DingTalk personal-event Source. Explicit command prefix; bot-only replies, off by default. */
import type { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { Later } from '../app/effects.ts'
import { record } from '../kv.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'
import { consumeDingtalkBot } from './dingtalk-bot.ts'
import { dingtalkBotReplyAllowed, dingtalkConversationContext, sendDingtalkBotReply } from './dingtalk-conversation.ts'
import { explicitPolicy } from './explicit-policy.ts'

export const DingtalkConfigSchema = z.object({
  cli: z.string().min(1).default('dws'), profile: z.string().default(''),
  chats: z.array(z.object({ id: z.string().min(1), name: z.string().optional() }).strict()).default([]),
  directMessages: z.boolean().default(false), mentions: z.boolean().default(false),
  prefix: z.string().trim().min(1).default('superagent:'),
  botAppId: z.string().default(''), botReplies: z.boolean().default(false),
  robotCode: z.string().default(''), replies: z.boolean().default(false),
}).strict()
export type DingtalkConfig = z.infer<typeof DingtalkConfigSchema>
const EventSchema = z.looseObject({
  type: z.enum(['user_im_message_receive_group', 'user_im_message_receive_o2o_all', 'user_im_message_receive_at']), conversation_id: z.string().min(1), message_id: z.string().min(1),
  sender_open_dingtalk_id: z.string().min(1), content: z.string(),
  event_time: z.number().optional(), timestamp: z.number().optional(), create_time: z.string().optional(),
  quoted_message: z.looseObject({ message_id: z.string().optional() }).optional(),
})
const triggerId = (chat: string, id: string) => key('dingtalk', chat, id)
export function dingtalkTrigger(value: unknown, config: DingtalkConfig, root?: string, human = false): Trigger {
  const e = EventSchema.parse(value)
  const mentioned = e.type === 'user_im_message_receive_at'
  if (mentioned) human = false // A mention of the personal account is an analysis signal, never execution authority.
  const time = e.event_time ?? e.timestamp ?? Number(e.create_time)
  const at = Number.isFinite(time) ? new Date(time < 1e12 ? time * 1000 : time).toISOString() : new Date(e.create_time ?? '').toISOString()
  const quoted = e.quoted_message?.message_id
  const thread = `${e.conversation_id}:${root ?? quoted ?? e.message_id}`
  return { id: triggerId(e.conversation_id, e.message_id), source: 'dingtalk',
    threads: [{ source: 'dingtalk', id: thread }], actor: { source: 'dingtalk', id: human ? e.sender_open_dingtalk_id : '' },
    // Only an explicitly allow-listed platform identity can pass the Policy. Content never supplies the identity.
    human, ...(!mentioned && e.content.trimStart().startsWith(config.prefix) ? { addressed: 'direct' as const } : {}),
    at, text: mentioned ? `[平台 @我事件：本消息提及当前钉钉账号；仅供分析]
${e.content}` : e.content, channel: { source: 'dingtalk', thread: `dingtalk:${thread}`,
      address: { chat: e.conversation_id, message: e.message_id, ...(e.type === 'user_im_message_receive_o2o_all' ? { direct: 'true' } : {}) } },
    meta: { mentioned, direct: e.type === 'user_im_message_receive_o2o_all', senderId: e.sender_open_dingtalk_id, chat: e.conversation_id, messageId: e.message_id, root: root ?? quoted ?? e.message_id, ...(quoted ? { parentId: quoted } : {}) } }
}
const flags = (c: DingtalkConfig) => c.profile ? ['--profile', c.profile] : []
export function dingtalkKind(getConfig: () => DingtalkConfig | undefined, state?: SourceContext['state']): SourceKind<DingtalkConfig> {
  return { kind: 'dingtalk', title: { zh: '钉钉', en: 'DingTalk' },
    description: { zh: '接收指定群、跨群 @当前账号及可选的当前账号全部私聊；普通消息进入观察，只有名单内用户的明确指令可接单。', en: 'Configured groups and optional account-wide direct messages; explicit command prefix. Bot replies are off by default.' },
    schema: DingtalkConfigSchema, health: ['dingtalk', 'dingtalk-bot'], fields: [
      { key: 'cli', type: 'text', label: { zh: 'dws CLI', en: 'dws CLI' } },
      { key: 'profile', type: 'text', label: { zh: '组织 Profile（空为当前组织）', en: 'Organization profile (empty: current)' } },
      { key: 'chats', type: 'rows', label: { zh: '接收群', en: 'Receiving groups' }, columns: [{ key: 'id', type: 'text', label: { zh: 'openConversationId', en: 'openConversationId' } }] },
      { key: 'mentions', type: 'switch', label: { zh: '接收跨群 @当前账号的消息（仅分析）', en: 'Receive account mentions across groups (analysis only)' } },
      { key: 'directMessages', type: 'switch', label: { zh: '接收当前账号全部私聊', en: 'Receive all account direct messages' } },
      { key: 'prefix', type: 'text', label: { zh: '明确指令前缀', en: 'Explicit command prefix' } },
      { key: 'botAppId', type: 'text', label: { zh: '接收机器人私聊的统一应用 ID（空为关闭）', en: 'Robot DM unified app ID (empty: off)' } },
      { key: 'botReplies', type: 'switch', label: { zh: '允许回复机器人私聊（不授予任务执行）', en: 'Reply to robot private chats (no execution grant)' } },
      { key: 'robotCode', type: 'text', label: { zh: '回复机器人 robotCode', en: 'Reply robotCode' } },
      { key: 'replies', type: 'switch', label: { zh: '允许机器人回复', en: 'Enable bot replies' } },
    ], scope: ({ meta }, c) => meta.bot === true
      ? c.botAppId && meta.robotCode === c.robotCode ? { listened: true, observed: true, row: 'all' } : { listened: false, reason: 'bot_messages_not_allowed' }
      : meta.mentioned === true
      ? c.mentions ? { listened: true, observed: true, row: 'all' } : { listened: false, reason: 'mentions_not_allowed' }
      : meta.direct === true
      ? c.directMessages ? { listened: true, observed: true, row: 'all' } : { listened: false, reason: 'direct_messages_not_allowed' }
      : c.chats.some(chat => chat.id === meta.chat) ? { listened: true, observed: true, row: 'all' } : { listened: false, reason: 'chat_not_allowed' },
    ...(state ? { threadContext: dingtalkConversationContext(state) } : {}),
    repliesTo: t => typeof t.meta.parentId === 'string' ? triggerId(String(t.meta.chat), t.meta.parentId) : undefined,
    policy: explicitPolicy('名单内用户以指令前缀开头的消息才是明确请求；@当前用户不会自动接单。', 'Only listed users and the configured prefix explicitly request work.'),
    channel: { allowed: (a, c) => a.robot ? dingtalkBotReplyAllowed(a, c, state) : a.direct !== 'true' && c.chats.some(chat => chat.id === a.chat),
      link: () => ({ url: '', label: { zh: '钉钉消息', en: 'DingTalk message' } }),
      async send(host, message) {
        const c = getConfig()
        if (message.channel.address.robot) {
          if (!c || !state) throw new Later('Robot private-chat reply configuration is unavailable')
          return sendDingtalkBotReply(host, message, c, state)
        }
        if (message.channel.address.direct === 'true') throw new Later('DingTalk direct-message replies are not configured')
        if (!c?.replies || !c.robotCode) throw new Later('DingTalk bot replies require explicit configuration')
        if (!state) throw new Later('DingTalk reply requires durable receipt tracking')
        const receipt = record<string>(`dingtalk:reply:${message.id}`)
        const previous = state.get(receipt)
        if (previous === 'sent') return 'sent'
        if (previous) throw new Later('DingTalk reply outcome uncertain; reconcile before another attempt')
        state.set(receipt, 'sending')
        const raw = await host.commands.run(c.cli, ['chat', '+messages-reply', ...flags(c), '--as', 'bot', '--robot-code', c.robotCode,
          '--group', message.channel.address.chat!, '--message-id', message.channel.address.message!,
          '--content', message.text, '--idempotency-key', message.id, '--yes', '--format', 'json'])
        const result = JSON.parse(raw) as { ok?: boolean; success?: boolean; error?: unknown; processQueryKey?: string }
        if (result.ok === false || result.success === false || result.error) throw new Error('DingTalk rejected reply; inspect CLI diagnostics')
        // Bot API acceptance must include an explicit success indication, not merely exit 0.
        if (!result.processQueryKey) throw new Error('Unrecognized DingTalk reply receipt; verify before retrying')
        state.set(receipt, 'sent')
        return 'sent'
      } },
    environment: { variables: [{ key: 'DSH_SUPERAGENT_DINGTALK_CHAT', description: { zh: '发起任务的钉钉群', en: 'Origin DingTalk chat' } }],
      values: ({ trigger }) => ({ DSH_SUPERAGENT_DINGTALK_CHAT: trigger?.source === 'dingtalk' ? String(trigger.meta.chat ?? '') : '' }) },
  }
}
/** Consume one continuous stream, sequentially admitting messages before reading the next. SIGTERM cancels this CLI consumer, without invoking event stop or deleting shared subscriptions. */
async function consume(ctx: SourceContext, c: DingtalkConfig, chat: string | undefined, signal: AbortSignal, humans: () => string[], mentions = false): Promise<void> {
  const changed = new AbortController()
  const streamSignal = AbortSignal.any([signal, changed.signal])
  const monitor = setInterval(() => { if (JSON.stringify(ctx.config('dingtalk')) !== JSON.stringify(c)) changed.abort() }, 1000)
  const args = mentions ? ['event', '+listen-im', '--kind', 'at-me'] : chat ? ['event', 'consume', 'user_im_message_receive_group', '--group', chat, '--flatten']
    : ['event', '+listen-im', '--kind', 'all-direct']
  const child = spawn(c.cli, [...args, ...flags(c), '--duration', '0', '--format', 'ndjson'],
    { stdio: ['pipe', 'pipe', 'pipe'], signal: streamSignal, killSignal: 'SIGTERM' })
  // Observe failure immediately so a spawn error cannot become an unhandled rejection while stdout drains.
  const finished = once(child, 'close').then(([code]) => code as number | null, error => { if (streamSignal.aborted) return null; throw error })
  finished.catch(() => {})
  let ready = false
  child.stderr.on('data', (value: Buffer) => { if (value.toString().includes('[event] ready')) { ready = true; ctx.report('dingtalk', { state: 'ready', detail: 'DingTalk stream ready (live events only)' }) } })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (signal.aborted || JSON.stringify(ctx.config('dingtalk')) !== JSON.stringify(c)) break
      if (!line.trim()) continue
      if (line.length > 1024 * 1024) throw new Error('Oversize DingTalk event')
      const e = EventSchema.parse(JSON.parse(line))
      if (mentions ? e.type !== 'user_im_message_receive_at' : chat ? e.type !== 'user_im_message_receive_group' || e.conversation_id !== chat : e.type !== 'user_im_message_receive_o2o_all') throw new Error('DingTalk stream returned another conversation')
      const parent = e.quoted_message?.message_id ? ctx.triggers.get(triggerId(e.conversation_id, e.quoted_message.message_id)) : undefined
      const t = dingtalkTrigger(e, c, parent ? String(parent.meta.root) : undefined, humans().includes(e.sender_open_dingtalk_id))
      await ctx.receive(t)
    }
  } finally { clearInterval(monitor); lines.close(); if (child.exitCode === null) child.kill('SIGTERM') }
  const code = await finished
  if (!streamSignal.aborted && (!ready || code !== 0)) throw new Error('DingTalk event consumer stopped before a successful ready stream')
}
async function run(ctx: SourceContext, signal: AbortSignal, humans: () => string[]): Promise<void> {
  await ctx.ready
  while (!signal.aborted) {
    const c = ctx.config<DingtalkConfig>('dingtalk')
    if (!ctx.configured() || !c || (!c.chats.length && !c.directMessages && !c.mentions && !c.botAppId)) {
      ctx.report('dingtalk', { state: 'paused', detail: 'Waiting for group or direct-message configuration' }); await pause(1000, signal); continue
    }
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const jobs = c.chats.map(chat => consume(ctx, c, chat.id, combined, humans))
    if (c.mentions) jobs.push(consume(ctx, c, undefined, combined, humans, true))
    if (c.directMessages) jobs.push(consume(ctx, c, undefined, combined, humans))
    if (c.botAppId) jobs.push(consumeDingtalkBot(ctx, c, combined).catch(error => {
      if (!combined.aborted) ctx.report('dingtalk-bot', { state: 'error', detail: 'Robot private-message consumer failed; verify application credentials and callback contract' })
      throw error
    }))
    else ctx.report('dingtalk-bot', { state: 'paused', detail: 'Robot private messages are off' })
    try { await Promise.all(jobs) }
    catch { if (!signal.aborted) ctx.report('dingtalk', { state: 'error', detail: 'DingTalk consumer failed; check profile, subscription and event contract' }) }
    finally { controller.abort(); await Promise.allSettled(jobs) }
    await pause(2000, signal)
  }
}
export const name = 'dsh-superagent-dingtalk'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  let host: SourceContext
  const state: SourceContext['state'] = { get: k => host.state.get(k), set: (k, v) => host.state.set(k, v), keys: f => host.state.keys(f) }
  const kind = dingtalkKind(() => host?.config<DingtalkConfig>('dingtalk'), state)
  ctx.effect(() => ctx.orchestrator.sources.register(kind))
  host = sourceContext(ctx.orchestrator, kind)
  ctx.effect(() => { const abort = new AbortController(); const running = run(host, abort.signal, () => (ctx.orchestrator.sources.policyPart('dingtalk')?.allowed ?? []).map(item => item.id))
    return async () => { abort.abort(); await running } })
}

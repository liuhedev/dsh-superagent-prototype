/** Bounded robot-private-chat context and a reply-only bot transport over the existing Outbox. */
import { Later } from '../app/effects.ts'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { record } from '../kv.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import type { SourceContext } from './host.ts'
import type { DingtalkConfig } from './dingtalk.ts'

type State = SourceContext['state']
interface Conversation { robot: string; chat: string; user: string; messages: ContextMessage[] }
const historyKey = (chat: string) => record<Conversation>(`dingtalk:conversation:${chat}`)
function append(state: State, conversation: Conversation, message: ContextMessage): void {
  if (conversation.messages.some(item => item.id === message.id)) return
  const messages = [...conversation.messages, { ...message, text: message.text.slice(0, 6000) }].sort((a, b) => a.at.localeCompare(b.at)).slice(-30)
  while (messages.length > 1 && messages.reduce((n, item) => n + item.text.length, 0) > 24000) messages.shift()
  state.set(historyKey(conversation.chat), { ...conversation, messages })
}
/** Only the authenticated robot callback receiver calls this; native recipient IDs never come from message text. */
export function rememberDingtalkMessage(state: State, trigger: Trigger): void {
  const a = trigger.channel?.address
  if (trigger.meta.bot !== true || !a?.robot || !a.user) return
  const stored = state.get(historyKey(a.chat!))
  if (stored && (stored.robot !== a.robot || stored.user !== a.user)) throw new Error('Robot conversation identity changed')
  const conversation = stored ?? { robot: a.robot, chat: a.chat!, user: a.user, messages: [] }
  append(state, conversation, { id: String(trigger.meta.messageId), from: trigger.actor.id, at: trigger.at, text: trigger.text })
}
export function dingtalkConversationContext(state: State): ThreadContext<DingtalkConfig> {
  return {
    messageId: t => String(t.meta.messageId),
    async read(_commands, trigger, part, cursor) {
      if (cursor) throw new Error('DingTalk recent context has no pagination')
      const a = trigger.channel?.address
      const conversation = a?.robot && a.user ? state.get(historyKey(a.chat!)) : undefined
      const valid = conversation && conversation.robot === a?.robot && conversation.user === a?.user
      const messages = valid ? conversation.messages.filter(m => m.at <= trigger.at) : []
      const selected = part === 'parent' ? messages.filter(m => m.id === trigger.meta.parentId)
        : part === 'root' ? messages.slice(0, 1) : messages
      return { messages: selected, body: { robot_private_chat: trigger.meta.bot === true,
        receiving_only: !a?.robot, context_scope: 'recent locally received messages, capped at 30 messages / 24000 characters; no historical backfill' }, status: 'bounded_local_history' }
    },
  }
}
export function dingtalkBotReplyAllowed(a: Record<string, string>, c: DingtalkConfig, state?: State): boolean {
  if (!state || !c.botReplies || !c.botAppId || !a.robot || a.robot !== c.robotCode || a.direct !== 'true' || !a.user) return false
  const conversation = state.get(historyKey(a.chat!))
  return !!conversation && conversation.robot === a.robot && conversation.user === a.user
    && conversation.messages.some(m => m.id === a.message && !m.bot)
}
export async function sendDingtalkBotReply(host: Pick<SourceContext, 'commands'>, message: OutboundMessage, c: DingtalkConfig, state: State): Promise<'sent'> {
  const a = message.channel.address
  if (!dingtalkBotReplyAllowed(a, c, state)) throw new Later('Robot private-chat replies are off or recipient provenance is missing')
  if (message.kind !== 'reply' || message.text.length > 4000) throw new Later('Only concise robot private-chat answers are allowed')
  // One answer per incoming message, including retries with altered wording. Bot API has no idempotency key.
  const receiptKey = record<{ id: string; status: 'sending' | 'sent'; processQueryKey?: string; text: string }>(`dingtalk:bot-answer:${key(a.chat!, a.message!)}`)
  const prior = state.get(receiptKey)
  if (prior) {
    if (prior.id !== message.id || prior.status !== 'sent') throw new Later('Bot reply outcome uncertain or another answer exists; reconcile before retrying')
    rememberSent(state, a, message, prior.text)
    return 'sent'
  }
  state.set(receiptKey, { id: message.id, status: 'sending', text: message.text })
  const raw = await host.commands.run(c.cli, ['chat', '+messages-send', ...(c.profile ? ['--profile', c.profile] : []),
    '--as', 'bot', '--robot-code', c.robotCode, '--users', a.user!, '--text', message.text, '--yes', '--format', 'json'])
  const result = JSON.parse(raw) as { ok?: boolean; success?: boolean; error?: unknown; failedCount?: number; failedUserIds?: string[]; processQueryKey?: string;
    data?: { success?: boolean; failedCount?: number; failedUserIds?: string[]; processQueryKey?: string } }
  const receipt = result.data ?? result
  if (result.ok === false || result.success === false || result.error || result.failedCount || receipt.failedCount || receipt.success === false || receipt.failedUserIds?.length
    || typeof receipt.processQueryKey !== 'string' || !receipt.processQueryKey) throw new Later('Bot reply lacks a successful receipt; verify before retrying')
  state.set(receiptKey, { id: message.id, status: 'sent', processQueryKey: receipt.processQueryKey, text: message.text })
  rememberSent(state, a, message, message.text)
  return 'sent'
}
function rememberSent(state: State, a: Record<string, string>, message: OutboundMessage, text: string): void {
  const conversation = state.get(historyKey(a.chat!))
  if (!conversation || conversation.user !== a.user || conversation.robot !== a.robot) return
  append(state, conversation, { id: message.id, from: a.robot!, at: new Date().toISOString(), text, bot: true })
}

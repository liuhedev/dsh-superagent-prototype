/** Robot private messages feed the existing evaluator and reply channel; no separate agent loop. */
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import { rememberDingtalkMessage } from './dingtalk-conversation.ts'
import { pause } from './poll.ts'
import { dingtalkTrigger, type DingtalkConfig } from './dingtalk.ts'

const RobotMessage = z.looseObject({
  robotCode: z.string().min(1), conversationType: z.string(),
  conversationId: z.string().min(1), msgId: z.string().min(1),
  senderId: z.string().min(1), senderStaffId: z.string().min(1).optional(), createAt: z.number(), msgtype: z.string(),
  text: z.object({ content: z.string() }).optional(),
})
export function dingtalkBotTrigger(value: unknown, c: DingtalkConfig): Trigger | undefined {
  const e = RobotMessage.parse(value)
  if (e.robotCode !== c.robotCode) throw new Error('Robot callback identity mismatch')
  if (e.conversationType !== '1') return // Only bot private chats; groups retain their existing receiver.
  const t = dingtalkTrigger({ type: 'user_im_message_receive_o2o_all',
    conversation_id: `bot:${e.robotCode}:${e.conversationId}`, message_id: e.msgId,
    sender_open_dingtalk_id: e.senderId, event_time: e.createAt,
    content: e.text?.content ?? `[DingTalk ${e.msgtype} message; body not downloaded]`,
  }, c)
  // Stable private-conversation thread. The callback sender identity never inherits the work allow-list.
  const thread = `${String(t.meta.chat)}:conversation`
  t.threads = [{ source: 'dingtalk', id: thread }]
  t.human = true
  t.actor.id = `bot-user:${e.robotCode}:${e.senderId}`
  delete t.addressed // Chat access does not grant an explicit work dispatch, even with the personal command prefix.
  t.channel = { ...t.channel!, thread: `dingtalk:${thread}`, address: { ...t.channel!.address,
    robot: e.robotCode, ...(e.senderStaffId ? { user: e.senderStaffId } : {}) } }
  t.meta = { ...t.meta, bot: true, robotCode: e.robotCode, nativeChat: e.conversationId }
  return t
}
export async function consumeDingtalkBot(ctx: SourceContext, c: DingtalkConfig, signal: AbortSignal): Promise<void> {
  const raw = await ctx.commands.run(c.cli, ['dev', 'app', 'credentials', 'get', '--unified-app-id', c.botAppId,
    ...(c.profile ? ['--profile', c.profile] : []), '--format', 'json'])
  const credentials = z.object({ ok: z.literal(true), data: z.object({ appKey: z.string().min(1), appSecret: z.string().min(1) }) }).parse(JSON.parse(raw))
  if (credentials.data.appKey !== c.robotCode) throw new Error('Configured robot does not match application credentials')
  if (signal.aborted) return
  const client = new DWClient({ clientId: credentials.data.appKey, clientSecret: credentials.data.appSecret, debug: false, keepAlive: true })
  let pending = 0
  client.registerCallbackListener(TOPIC_ROBOT, frame => {
    if (signal.aborted || pending >= 20) return // No ACK: allow server retry instead of unbounded queueing.
    pending++
    void (async () => {
      try {
        if (frame.data.length > 1024 * 1024) throw new Error('Oversize robot callback')
        const t = dingtalkBotTrigger(JSON.parse(frame.data), c)
        if (t) {
          ctx.atomic(() => rememberDingtalkMessage(ctx.state, t))
          await ctx.receive(t)
        } // ACK only after durable ingestion (duplicate IDs are idempotent).
        client.socketCallBackResponse(frame.headers.messageId, { status: 'SUCCESS' })
      } catch {
        ctx.report('dingtalk-bot', { state: 'error', detail: 'Robot callback not acknowledged; inspect message contract or storage' })
      } finally { pending-- }
    })()
  })
  const stop = () => client.disconnect()
  signal.addEventListener('abort', stop, { once: true })
  let connectionFailed = false
  const connecting = client.connect().catch(() => { connectionFailed = true })
  try {
    while (!signal.aborted && JSON.stringify(ctx.config('dingtalk')) === JSON.stringify(c)) {
      if (connectionFailed) throw new Error('Robot Stream connection failed')
      ctx.report('dingtalk-bot', client.connected
        ? { state: 'ready', detail: c.botReplies ? 'Robot private-message Stream connected; chat replies enabled' : 'Robot private-message Stream connected; observation only' }
        : { state: 'starting', detail: 'Connecting robot private-message Stream' })
      await pause(1000, signal)
    }
  } finally {
    signal.removeEventListener('abort', stop)
    stop()
    void connecting.catch(() => {})
  }
}

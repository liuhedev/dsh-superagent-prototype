/** Read-only, bounded discovery for the DingTalk settings card. Never reads application secrets. */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import type { DingtalkConfig } from './dingtalk.ts'

export interface DingtalkDiscovery {
  account: string
  groups: { id: string; name: string }[]
  robots: { id: string; name: string; robotCode: string }[]
  warnings: string[]
}
const Account = z.object({ ok: z.literal(true), data: z.object({ name: z.string().min(1), org: z.string().min(1) }) })
const Groups = z.object({ chats: z.array(z.object({ openConversationId: z.string().min(1), name: z.string().min(1) })),
  complete: z.boolean() })
const Apps = z.object({ ok: z.literal(true), data: z.object({ items: z.array(z.object({ unifiedAppId: z.string().min(1),
  robotName: z.string().optional() })) }), meta: z.object({ pagination: z.object({ endpoint_exhausted: z.boolean(),
    next_token: z.string().optional() }) }) })
const App = z.object({ ok: z.literal(true), data: z.object({ unifiedAppId: z.string().min(1), name: z.string().min(1),
  appKey: z.string().min(1), appStatus: z.string() }) })

export async function discoverDingtalk(commands: Commands, config: DingtalkConfig, groupQuery?: string): Promise<DingtalkDiscovery> {
  const read = async (args: string[]) => JSON.parse(await commands.run(config.cli,
    [...args, ...(config.profile ? ['--profile', config.profile] : []), '--format', 'json'])) as unknown
  const account = Account.parse(await read(['contact', '+me'])).data
  const result: DingtalkDiscovery = { account: `${account.name} · ${account.org}`, groups: [], robots: [], warnings: [] }
  if (groupQuery !== undefined) {
    const query = z.string().trim().min(1).max(100).parse(groupQuery)
    const page = Groups.parse(await read(['chat', '+chat-search', '--query', query, '--limit', '20']))
    result.groups = page.chats.map(group => ({ id: group.openConversationId, name: group.name }))
    if (!page.complete) result.warnings.push('仅显示前 20 个结果，请输入更完整的群名。 / Showing up to 20 matches; refine the group name.')
    return result
  }
  await Promise.all([
    (async () => {
      try {
        const ids = new Set<string>(config.botAppId ? [config.botAppId] : [])
        let cursor: string | undefined
        for (let page = 0; page < 5; page++) {
          const data = Apps.parse(await read(['dev', 'app', 'list', '--page-size', '20', ...(cursor ? ['--cursor', cursor] : [])]))
          for (const app of data.data.items) if (app.robotName) ids.add(app.unifiedAppId)
          if (data.meta.pagination.endpoint_exhausted) break
          const next = data.meta.pagination.next_token
          if (!next || next === cursor) throw new Error('Invalid application cursor')
          cursor = next
          if (page === 4) result.warnings.push('应用列表未读完（最多 100 个）。 / Application list is partial (limit 100).')
        }
        if (ids.size > 20) result.warnings.push('仅显示前 20 个可读取的机器人应用。 / Showing up to 20 robot applications.')
        const candidates = [...ids].slice(0, 20)
        for (let start = 0; start < candidates.length; start += 4) {
          await Promise.all(candidates.slice(start, start + 4).map(async id => {
            try {
              const app = App.parse(await read(['dev', 'app', 'get', '--unified-app-id', id])).data
              if (app.unifiedAppId !== id) throw new Error('Application identity mismatch')
              if (app.appStatus === 'published') result.robots.push({ id, name: app.name, robotCode: app.appKey })
            } catch { result.warnings.push('有机器人应用无法读取，请检查应用管理权限。 / Some robot applications could not be read.') }
          }))
        }
      } catch { result.warnings.push('机器人列表读取失败，请检查应用管理权限；仍可在高级设置填写。 / Could not read robot applications; manual setup is available in Advanced.') }
    })(),
  ])
  result.groups.sort((a, b) => a.name.localeCompare(b.name))
  result.robots.sort((a, b) => a.name.localeCompare(b.name))
  result.warnings = [...new Set(result.warnings)]
  return result
}

/** Optional account-wide or single-project GitLab Source, with overlap-safe polling and validated MR binding. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { key, liveTicket, type Trigger } from '../core/index.ts'
import { Later } from '../app/effects.ts'
import { record } from '../kv.ts'
import type { Commands } from '../infra/commands.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { cursorAt, pause, polled } from './poll.ts'
import { explicitPolicy } from './explicit-policy.ts'

export const GitlabConfigSchema = z.object({
  cli: z.string().min(1).default('glab'), hostname: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]+)?$/).default('gitlab.com'),
  project: z.string().regex(/^(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+$/).or(z.literal('')).default(''),
  login: z.string().regex(/^[a-zA-Z0-9_.-]*$/).default(''), pollSeconds: z.number().int().min(15).max(3600).default(60),
  allProjects: z.boolean().default(false), pipelineBatch: z.number().int().min(1).max(100).default(20),
  replies: z.boolean().default(false),
}).strict().refine(c => !c.project.split('/').some(part => ['.', '..'].includes(part)), 'Invalid project path')
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
export const projectPath = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+$/.test(value) && !value.split('/').some(p => p === '.' || p === '..')
const Actor = z.looseObject({ username: z.string(), bot: z.boolean().optional() })
export const GitlabItem = z.looseObject({ iid: z.number().int().positive(), project_id: z.number().int().positive().optional(), title: z.string(), description: z.string().nullish(),
  state: z.string(), web_url: z.string().url(), author: Actor, created_at: z.string(), updated_at: z.string(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish(), source_branch: z.string().optional(),
  source_project_id: z.number().nullish(), target_project_id: z.number().optional(),
  head_pipeline: z.looseObject({ id: z.number(), status: z.string(), sha: z.string().optional() }).nullish(),
})
const Note = z.looseObject({ id: z.number(), body: z.string(), author: Actor, system: z.boolean(), created_at: z.string(), updated_at: z.string() })
type Item = z.infer<typeof GitlabItem>
type Kind = 'issues' | 'merge_requests'
const ident = (c: GitlabConfig) => `${c.hostname}/${c.project}`
export const gitlabThreadId = (c: GitlabConfig, kind: Kind, iid: number) => `${ident(c)}:${kind}:${iid}`
const cursor = (c: GitlabConfig) => record<string>(`gitlab:cursor:${ident(c)}:${c.login}`)
/** Only project-relative endpoints assembled internally reach this function. */
export async function gitlabApi(commands: Commands, c: GitlabConfig, path: string, method = 'GET', body?: string): Promise<unknown> {
  if (!projectPath(c.project) || /(^|\/)\.\.?($|\/)|^[a-z]+:|^\//i.test(path)) throw new Error('GitLab endpoint must stay within the configured project')
  const args = ['api', `projects/${encodeURIComponent(c.project)}${path ? `/${path}` : ''}`, '--hostname', c.hostname, '--method', method]
  if (body !== undefined) args.push('--raw-field', `body=${body}`)
  return JSON.parse(await commands.run(c.cli, args))
}
async function pages<T>(commands: Commands, c: GitlabConfig, path: string, schema: z.ZodType<T>): Promise<T[]> {
  const result: T[] = []
  for (let page = 1; page <= 100; page++) {
    const values = z.array(schema).parse(await gitlabApi(commands, c, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`))
    result.push(...values)
    if (values.length < 100) return result
  }
  throw new Error('GitLab pagination budget reached; cursor retained')
}
const mentions = (text: string, login: string) => !!login && new RegExp(`(^|[^\\w])@${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'i').test(text)
export function gitlabTrigger(c: GitlabConfig, kind: Kind, item: Item, note?: z.infer<typeof Note>): Trigger | undefined {
  const author = note?.author ?? item.author
  const text = note?.body ?? `${item.title}\n\n${item.description ?? ''}`
  if (text.includes('<!-- dsh-superagent:')) return undefined
  if (note?.system) return undefined
  const thread = gitlabThreadId(c, kind, item.iid)
  const url = note ? `${item.web_url}#note_${note.id}` : item.web_url
  return { id: key('gitlab', thread, note ? String(note.id) : 'body', note?.updated_at ?? item.updated_at), source: 'gitlab',
    threads: [{ source: 'gitlab', id: thread }], actor: { source: 'gitlab', id: author.username }, human: author.bot !== true,
    ...(!c.allProjects && mentions(text, c.login) ? { addressed: 'mention' as const } : {}), at: note?.updated_at ?? item.updated_at,
    text, url, channel: { source: 'gitlab', thread: `gitlab:${thread}`,
      address: { hostname: c.hostname, project: c.project, kind, iid: String(item.iid), url: item.web_url } },
    meta: { hostname: c.hostname, project: c.project, kind, iid: item.iid, ...(note ? { noteId: note.id } : {}) } }
}
function itemPath(kind: string, iid: unknown): string {
  if (!['issues', 'merge_requests'].includes(kind) || !Number.isSafeInteger(Number(iid)) || Number(iid) <= 0) throw new Error('Invalid GitLab item address')
  return `${kind}/${iid}`
}
export function gitlabKind(getConfig: () => GitlabConfig | undefined): SourceKind<GitlabConfig> {
  return { kind: 'gitlab', title: { zh: 'GitLab', en: 'GitLab' },
    description: { zh: '接收账号可访问项目的 Issue、MR、评论与流水线，或兼容单仓库模式。默认不回复。', en: 'Poll accessible projects: issues, MRs, notes and pipelines. Replies off by default.' },
    schema: GitlabConfigSchema, health: ['gitlab'], fields: [
      ...(['cli', 'hostname', 'project', 'login'] as const).map(k => ({ key: k, type: 'text' as const, label: { zh: k, en: k } })),
      { key: 'allProjects', type: 'switch', label: { zh: '监听全部项目', en: 'Watch all projects' }, hint: { zh: '开启后扫描当前账号可访问的全部项目；关闭时只监听指定 project。项目较多时建议指定项目。', en: 'Scans all projects accessible to this account. Otherwise only the configured project is watched. Prefer a specific project for large accounts.' } },
      { key: 'pipelineBatch', type: 'number', min: 1, max: 100, label: { zh: '每轮项目数', en: 'Projects per pass' }, hint: { zh: '每轮最多扫描多少个项目的流水线，用于控制请求量。', en: 'Maximum projects whose pipelines are scanned per pass, to bound requests.' } },
      { key: 'pollSeconds', type: 'number', min: 15, max: 3600, label: { zh: '轮询间隔（秒）', en: 'Poll interval (seconds)' } },
      { key: 'replies', type: 'switch', label: { zh: '允许评论回复', en: 'Enable comment replies' } },
    ], scope: ({ meta }, c) => meta.hostname === c.hostname && projectPath(meta.project) && (c.allProjects || meta.project === c.project) ? { listened: true, observed: c.allProjects || meta.ci === true, row: 'all' } : { listened: false, reason: 'project_not_allowed' },
    policy: explicitPolicy('名单内用户 @配置的 GitLab 账号才是明确请求。', 'Listed users must mention the configured GitLab account.'),
    channel: { allowed: (a, c) => a.hostname === c.hostname && projectPath(a.project) && (c.allProjects || a.project === c.project),
      link: a => ({ url: a.url ?? '', label: { zh: 'GitLab 讨论', en: 'GitLab conversation' } }),
      async send(host, message) {
        const base = getConfig()
        if (!base?.replies) throw new Later('GitLab comment replies disabled')
        const c = resolveProject(base, message.channel.address.project)
        if (message.channel.address.hostname !== c.hostname) throw new Later('GitLab reply hostname mismatch')
        const path = itemPath(message.channel.address.kind!, message.channel.address.iid)
        const marker = `<!-- dsh-superagent:${message.id} -->`
        const notes = await pages(host.commands, c, `${path}/notes?sort=desc&order_by=created_at`, Note)
        if (notes.some(n => n.author.username.toLowerCase() === c.login.toLowerCase() && n.body.includes(marker))) return 'sent'
        if (JSON.stringify(getConfig()) !== JSON.stringify(base)) throw new Later('GitLab configuration changed before reply')
        const me = Actor.parse(JSON.parse(await host.commands.run(c.cli, ['api', 'user', '--hostname', c.hostname])))
        if (me.username.toLowerCase() !== c.login.toLowerCase()) throw new Later('GitLab reply account mismatch')
        if (JSON.stringify(getConfig()) !== JSON.stringify(base)) throw new Later('GitLab configuration changed before reply')
        const posted = Note.parse(await gitlabApi(host.commands, c, `${path}/notes`, 'POST', `${message.text}\n\n${marker}`))
        if (!posted.body.includes(marker) || posted.author.username.toLowerCase() !== c.login.toLowerCase()) throw new Error('GitLab reply marker missing')
        return 'sent'
      } },
    threadContext: { messageId: t => String(t.meta.noteId ?? t.meta.pipelineId ?? 'body'),
      async read(commands, trigger, _part, next, base) {
        const c = resolveProject(base, trigger.meta.project)
        if (trigger.meta.hostname !== c.hostname) throw new Error('GitLab context outside configured project')
        const page = next === undefined ? 1 : Number(next)
        if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw new Error('Invalid GitLab context cursor')
        if (trigger.meta.kind === 'pipelines') {
          const pipeline = PipelineSchema.parse(await gitlabApi(commands, c, `pipelines/${z.number().int().positive().parse(trigger.meta.pipelineId)}`))
          return { messages: [{ id: String(pipeline.id), from: 'GitLab CI', at: pipeline.updated_at ?? trigger.at, text: JSON.stringify(pipeline) }], body: { pipeline } }
        }
        const path = itemPath(String(trigger.meta.kind), trigger.meta.iid)
        const item = GitlabItem.parse(await gitlabApi(commands, c, path))
        const notes = z.array(Note).parse(await gitlabApi(commands, c, `${path}/notes?sort=asc&order_by=created_at&per_page=50&page=${page}`))
        return { messages: [...(page === 1 ? [{ id: 'body', from: item.author.username, at: item.created_at, text: `${item.title}\n${item.description ?? ''}`, url: item.web_url }] : []),
          ...notes.map(n => ({ id: String(n.id), from: n.author.username, at: n.created_at, text: n.body, ...(n.system || n.author.bot ? { bot: true as const } : {}) }))],
          ...(notes.length === 50 ? { next: String(page + 1) } : {}), body: { state: item.state, url: item.web_url } }
      } },
    environment: { variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: 'GitLab 主机', en: 'GitLab host' } },
      { key: 'DSH_SUPERAGENT_GITLAB_LOGIN', description: { zh: '已配置的 GitLab 账号', en: 'Configured GitLab account' } },
      { key: 'DSH_SUPERAGENT_GITLAB_CLI', description: { zh: 'GitLab CLI', en: 'GitLab CLI' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: 'GitLab 仓库路径', en: 'GitLab project path' } },
    ], values: ({ config, trigger }) => ({ DSH_SUPERAGENT_GITLAB_HOST: config.hostname, DSH_SUPERAGENT_GITLAB_PROJECT: config.allProjects ? (trigger?.source === 'gitlab' && projectPath(trigger.meta.project) ? trigger.meta.project : '') : config.project, DSH_SUPERAGENT_GITLAB_CLI: config.cli, DSH_SUPERAGENT_GITLAB_LOGIN: config.login }) },
  }
}
/** Validate authorship and branch ownership before binding a worker-created MR. No remote writes. */
export async function readGitlabMergeRequest(ctx: SourceContext, iid: number, ticketId: string, signal?: AbortSignal, project?: string): Promise<Item & { resolvedProject: string }> {
  const base = ctx.config<GitlabConfig>('gitlab')
  if (!base?.login) throw new Error('GitLab Source is not configured')
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) throw new Error('Ticket ended')
  const source = ctx.triggers.get(ticket.origin.triggerId)
  if (source?.source === 'gitlab' && (source.meta.hostname !== base.hostname || (project && project !== source.meta.project))) throw new Error('GitLab report must stay in the originating project')
  const c = resolveProject(base, project ?? (source?.source === 'gitlab' ? source.meta.project : base.project))
  const mr = GitlabItem.parse(await gitlabApi(ctx.commands.withSignal(signal), c, itemPath('merge_requests', iid)))
  const existing = source?.source === 'gitlab' && source.meta.project === c.project && source.meta.hostname === c.hostname && source.meta.kind === 'merge_requests' && source.meta.iid === iid
  if (!existing && (mr.author.username.toLowerCase() !== c.login.toLowerCase() || mr.source_project_id !== mr.target_project_id || (!ticket.execution?.name || mr.source_branch?.split('/').at(-1) !== ticket.execution.name)))
    throw new Error('MR must be the source MR, or authored by the configured account from this ticket branch in the same project')
  if (mr.state !== 'opened') throw new Error('MR is not open')
  return { ...mr, resolvedProject: c.project }
}
export function bindGitlabMergeRequest(ctx: SourceContext, ticketId: string, mr: Item & { resolvedProject?: string }): void {
  const base = ctx.config<GitlabConfig>('gitlab')
  if (!base) throw new Error('GitLab Source disabled')
  const c = resolveProject(base, mr.resolvedProject ?? base.project)
  const expected = `/${c.project}/-/merge_requests/${mr.iid}`
  const url = new URL(mr.web_url)
  if (url.host !== c.hostname || url.pathname !== expected) throw new Error('GitLab MR no longer matches configured project')
  const thread = gitlabThreadId(c, 'merge_requests', mr.iid)
  for (const other of ctx.tickets.open()) if (other.id !== ticketId && other.follows?.some(f => f.thread === `gitlab:${thread}` && !f.closed)) throw new Error('MR already owned by another ticket')
  const ticket = ctx.tickets.get(ticketId)
  const own = mr.author.username.toLowerCase() === c.login.toLowerCase() && mr.source_project_id === mr.target_project_id
    && !!ticket?.execution?.name && mr.source_branch?.split('/').at(-1) === ticket.execution.name
  ctx.tickets.bindThread(ticketId, { source: 'gitlab', id: thread }, own)
}
async function inspect(ctx: SourceContext, c: GitlabConfig, kind: Kind, item: Item, since: string): Promise<void> {
  const thread = gitlabThreadId(c, kind, item.iid)
  if (item.updated_at >= since) { const trigger = gitlabTrigger(c, kind, item); if (trigger) await ctx.receive(trigger) }
  const notes = await pages(ctx.commands, c, `${kind}/${item.iid}/notes?sort=asc&order_by=updated_at`, Note)
  for (const note of notes) if (note.updated_at >= since) { const trigger = gitlabTrigger(c, kind, item, note); if (trigger) await ctx.receive(trigger) }
  if (kind === 'merge_requests' && item.head_pipeline) {
    const pipeline = item.head_pipeline
    const hash = createHash('sha256').update(JSON.stringify(pipeline)).digest('hex')
    const fingerprint = record<{ hash: string; revision: number }>(`gitlab:pipeline:${thread}`)
    const previous = ctx.state.get(fingerprint)
    if (previous?.hash !== hash) {
      const revision = (previous?.revision ?? 0) + 1
    await ctx.receive({ id: key('gitlab', thread, 'ci', String(revision), hash), source: 'gitlab', threads: [{ source: 'gitlab', id: thread }],
      actor: { source: 'gitlab', id: '' }, human: false, at: new Date().toISOString(), text: `MR !${item.iid} pipeline ${pipeline.id}: ${pipeline.status}`,
      url: item.web_url, meta: { hostname: c.hostname, project: c.project, kind, iid: item.iid, ci: true } })
      ctx.state.set(fingerprint, { hash, revision })
    }
  }
  if (item.state === 'closed' || item.state === 'merged') ctx.tickets.threadClosed({ source: 'gitlab', id: thread }, item.state === 'merged' ? 'merged' : 'closed', item.merged_at ?? item.closed_at ?? item.updated_at)
}
export async function pollGitlab(ctx: SourceContext, c: GitlabConfig): Promise<void> {
  if (c.allProjects) { await pollAllGitlab(ctx, c); return }
  const me = Actor.parse(JSON.parse(await ctx.commands.run(c.cli, ['api', 'user', '--hostname', c.hostname])))
  if (me.username.toLowerCase() !== c.login.toLowerCase()) throw new Error('GitLab CLI account differs from configured login')
  const since = ctx.state.get(cursor(c))
  const started = new Date().toISOString()
  // New installations start now; do not accept the project's historical backlog.
  if (!since) {
    const project = z.looseObject({ path_with_namespace: z.string() }).parse(await gitlabApi(ctx.commands, c, ''))
    if (project.path_with_namespace !== c.project) throw new Error('GitLab project identity mismatch')
    ctx.state.set(cursor(c), cursorAt(started));
    ctx.state.set(record<string>(`gitlab:project-baseline:${ident(c)}:${c.login}`), started); return
  }
  const visited = new Set<string>()
  for (const kind of ['issues', 'merge_requests'] as const) {
    const items = await pages(ctx.commands, c, `${kind}?state=all&scope=all&updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=asc`, GitlabItem)
    for (const item of items) { await inspect(ctx, c, kind, item, since); visited.add(`${kind}:${item.iid}`) }
  }
  const prefix = `${ident(c)}:`
  for (const thread of ctx.threads.subscribed('gitlab')) {
    if (!polled(ctx, thread) || !thread.ref.id.startsWith(prefix)) continue
    const [kind, number] = thread.ref.id.slice(prefix.length).split(':')
    if (visited.has(`${kind}:${number}`)) continue
    const path = itemPath(kind!, number)
    const item = GitlabItem.parse(await gitlabApi(ctx.commands, c, path))
    await inspect(ctx, c, kind as Kind, item, since)
  }
  ctx.state.set(cursor(c), cursorAt(started))
  await pollProjectPipelines(ctx, c)
}
async function run(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  while (!signal.aborted) {
    const c = ctx.config<GitlabConfig>('gitlab')
    if (!ctx.configured() || !c || (!c.project && !c.allProjects) || !c.login) { ctx.report('gitlab', { state: 'paused', detail: 'Waiting for GitLab account or project scope' }); await pause(1000, signal); continue }
    try { await pollGitlab({ ...ctx, commands: ctx.commands.withSignal(signal) }, c); ctx.report('gitlab', { state: 'ready', detail: 'GitLab increment collected; pipelines rotate across accessible projects' }) }
    catch { if (!signal.aborted) ctx.report('gitlab', { state: 'error', detail: 'GitLab read failed; failed-partition checkpoints retained. Check project access and CLI contract' }) }
    await pause(c.pollSeconds * 1000, signal)
  }
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  let host: SourceContext
  const kind = gitlabKind(() => host?.config<GitlabConfig>('gitlab'))
  ctx.effect(() => ctx.orchestrator.sources.register(kind))
  host = sourceContext(ctx.orchestrator, kind)
  ctx.effect(() => { const abort = new AbortController(); const running = run(host, abort.signal); return async () => { abort.abort(); await running } })
}

/** Resolve source-provided project identity per event; a global receive scope never supplies a global write target. */
function resolveProject(base: GitlabConfig, project: unknown): GitlabConfig {
  if (!projectPath(project) || (!base.allProjects && project !== base.project)) throw new Error('GitLab project not in configured scope')
  return { ...base, project }
}
const ProjectSchema = z.looseObject({ id: z.number().int().positive(), path_with_namespace: z.string().refine(projectPath), archived: z.boolean().optional() })
const PipelineSchema = z.looseObject({ id: z.number().int().positive(), status: z.string(), ref: z.string().optional(), sha: z.string().optional(),
  created_at: z.string().optional(), updated_at: z.string().optional(), web_url: z.string().optional() })
const accountCursor = (c: GitlabConfig) => record<string>(`gitlab:account-cursor:${c.hostname}:${c.login}`)
/** The global reader is GET-only and has a closed endpoint list. Project writes still go through gitlabApi. */
async function globalApi(commands: Commands, c: GitlabConfig, path: string): Promise<unknown> {
  if (!/^(?:user$|(?:issues|merge_requests|projects)\?[^#]*$|projects\/[0-9]+$)/.test(path)) throw new Error('Unsupported GitLab account read')
  return JSON.parse(await commands.run(c.cli, ['api', path, '--hostname', c.hostname, '--method', 'GET']))
}
async function globalPages<T>(ctx: SourceContext, c: GitlabConfig, path: string, schema: z.ZodType<T>): Promise<T[]> {
  const result: T[] = []
  for (let page = 1; page <= 100; page++) {
    const values = z.array(schema).parse(await globalApi(ctx.commands, c, `${path}&per_page=100&page=${page}`))
    result.push(...values)
    if (values.length < 100) return result
  }
  throw new Error('GitLab account page budget reached; checkpoint retained')
}
async function pollAllGitlab(ctx: SourceContext, c: GitlabConfig): Promise<void> {
  const me = Actor.parse(await globalApi(ctx.commands, c, 'user'))
  if (me.username.toLowerCase() !== c.login.toLowerCase()) throw new Error('GitLab account mismatch')
  const since = ctx.state.get(accountCursor(c))
  const started = new Date().toISOString()
  if (!since) {
    ctx.state.set(accountCursor(c), cursorAt(started))
    ctx.state.set(record<string>(`gitlab:account-baseline:${c.hostname}:${c.login}`), started)
    return
  }
  const resolved = new Map<number, GitlabConfig>()
  const projectOf = async (id: number): Promise<GitlabConfig> => {
    const known = resolved.get(id)
    if (known) return known
    const project = ProjectSchema.parse(await globalApi(ctx.commands, c, `projects/${id}`))
    const config = resolveProject(c, project.path_with_namespace)
    resolved.set(id, config)
    return config
  }
  const visited = new Set<string>()
  for (const kind of ['issues', 'merge_requests'] as const) {
    const items = await globalPages(ctx, c, `${kind}?state=all&scope=all&updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=asc`, GitlabItem)
    for (const item of items) {
      const config = await projectOf(z.number().int().positive().parse(item.project_id))
      await inspect(ctx, config, kind, item, since)
      visited.add(gitlabThreadId(config, kind, item.iid))
    }
  }
  // Existing task subscriptions are refreshed independently of project discovery and item updated_at.
  const prefix = `${c.hostname}/`
  for (const thread of ctx.threads.subscribed('gitlab')) {
    if (!polled(ctx, thread) || !thread.ref.id.startsWith(prefix) || visited.has(thread.ref.id)) continue
    const match = /^(.*):(issues|merge_requests):([0-9]+)$/.exec(thread.ref.id.slice(prefix.length))
    if (!match) continue
    const config = resolveProject(c, match[1])
    const item = GitlabItem.parse(await gitlabApi(ctx.commands, config, itemPath(match[2]!, match[3])))
    await inspect(ctx, config, match[2] as Kind, item, since)
  }
  ctx.state.set(accountCursor(c), cursorAt(started))
  await pollProjectPipelines(ctx, c)
}
/** Fair bounded rotation, with independent per-project cursors; no repository allow-list and no historical backlog. */
async function pollProjectPipelines(ctx: SourceContext, c: GitlabConfig): Promise<void> {
  const rotation = record<{ page: number; failures: string[] }>(`gitlab:pipeline-rotation:${c.hostname}:${c.login}:${c.pipelineBatch}`)
  const state = ctx.state.get(rotation) ?? { page: 1, failures: [] }
  const projects = c.allProjects
    ? z.array(ProjectSchema).parse(await globalApi(ctx.commands, c, `projects?simple=true&order_by=id&sort=asc&per_page=${c.pipelineBatch}&page=${state.page}`))
    : [{ id: 0, path_with_namespace: c.project, archived: false }]
  const baseline = ctx.state.get(record<string>(c.allProjects ? `gitlab:account-baseline:${c.hostname}:${c.login}` : `gitlab:project-baseline:${ident(c)}:${c.login}`))
  if (!baseline) throw new Error('Missing GitLab account baseline')
  const failures: string[] = []
  let offset = 0
  const worker = async () => {
    while (offset < projects.length) {
      const project = projects[offset++]!
      if (project.archived) continue
      const config = resolveProject(c, project.path_with_namespace)
      const checkpoint = record<string>(`gitlab:pipelines-since:${ident(config)}:${c.login}`)
      const since = ctx.state.get(checkpoint) ?? baseline
      const started = new Date().toISOString()
      try {
        const pipelines = await pages(ctx.commands, config, `pipelines?updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=asc`, PipelineSchema)
        for (const pipeline of pipelines) {
          if (!pipeline.updated_at || !Number.isFinite(Date.parse(pipeline.updated_at))) throw new Error('Pipeline API has no valid update timestamp')
          if (Date.parse(pipeline.updated_at) < Date.parse(since)) continue
          const thread = `${ident(config)}:pipelines:${pipeline.id}`
          const fingerprint = record<{ hash: string; revision: number }>(`gitlab:pipeline-event:${thread}`)
          const hash = createHash('sha256').update(JSON.stringify(pipeline)).digest('hex')
          const previous = ctx.state.get(fingerprint)
          if (previous?.hash === hash) continue
          const revision = (previous?.revision ?? 0) + 1
          await ctx.receive({ id: key('gitlab', thread, 'pipeline', String(revision), hash), source: 'gitlab',
            threads: [{ source: 'gitlab', id: thread }], actor: { source: 'gitlab', id: '' }, human: false,
            at: pipeline.updated_at ?? started, text: `Project ${config.project}; pipeline ${pipeline.id}: ${pipeline.status}; ref=${pipeline.ref ?? ''}`,
            ...(pipeline.web_url ? { url: pipeline.web_url } : {}),
            meta: { hostname: config.hostname, project: config.project, kind: 'pipelines', pipelineId: pipeline.id, ci: true, status: pipeline.status } })
          ctx.state.set(fingerprint, { hash, revision })
        }
        ctx.state.set(checkpoint, cursorAt(started))
      } catch { failures.push(project.path_with_namespace) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, projects.length) }, worker))
  ctx.state.set(rotation, { page: projects.length < c.pipelineBatch ? 1 : state.page + 1, failures })
  if (failures.length) throw new Error(`Pipeline scan failed in ${failures.length} projects; independent checkpoints retained and rotation continues`)
}

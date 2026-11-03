#!/usr/bin/env node
/** Prepare one assigned GitLab repository without changing global Git or glab configuration. */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, basename } from 'node:path'
const env = process.env
const host = env.DSH_SUPERAGENT_GITLAB_HOST ?? ''
const project = env.DSH_SUPERAGENT_GITLAB_PROJECT ?? ''
const login = env.DSH_SUPERAGENT_GITLAB_LOGIN ?? ''
const cli = env.DSH_SUPERAGENT_GITLAB_CLI || 'glab'
const name = env.DSH_SUPERAGENT_NAME ?? ''
const dir = env.DSH_SUPERAGENT_DIR ?? ''
if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]+)?$/.test(host) || !/^(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+$/.test(project)
  || project.split('/').some(part => ['.', '..'].includes(part)) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)
  || !dir || resolve(dir) !== resolve(process.cwd(), name) || basename(dir) !== name || existsSync(dir)) throw new Error('Invalid or existing ticket workspace')
const run = (program, args, cwd) => execFileSync(program, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
const me = JSON.parse(run(cli, ['api', 'user', '--hostname', host]))
if (!login || me.username?.toLowerCase() !== login.toLowerCase()) throw new Error('GitLab CLI identity mismatch')
const info = JSON.parse(run(cli, ['api', `projects/${encodeURIComponent(project)}`, '--hostname', host]))
if (info.path_with_namespace !== project) throw new Error('GitLab project identity mismatch')
const email = me.commit_email || me.email
if (!email || !me.name || /[\r\n]/.test(email + me.name)) throw new Error('GitLab account has no usable commit identity')
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const helper = `!${quote(cli)} auth git-credential`
try {
  run('git', ['-c', 'credential.helper=', '-c', `credential.https://${host}.helper=${helper}`, 'clone', '--', `https://${host}/${project}.git`, dir])
  run('git', ['config', '--local', 'user.name', me.name], dir)
  run('git', ['config', '--local', 'user.email', email], dir)
  run('git', ['switch', '-c', name], dir)
} catch { throw new Error('GitLab workspace preparation failed; preserve and inspect partial workspace before retrying') }
console.log('GitLab ticket workspace ready')

/** Name-based DingTalk setup. Selection edits the existing draft; only Save changes the receiving scope. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DingtalkDiscovery } from '../sources/dingtalk-discovery.ts'
import { Button, Icon, InfoTip, Input } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'

export function DingtalkSetup({ config, saved, onChange, personalFields, robotFields }: {
  personalFields: ReactNode; robotFields: ReactNode;
  config: Record<string, unknown>; saved: Record<string, unknown>; onChange: (config: Record<string, unknown>) => void
}) {
  const { t, call } = usePanel()
  const text = (zh: string, en: string) => t('lang') === 'zh' ? zh : en
  const [data, setData] = useState<DingtalkDiscovery>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [groupQuery, setGroupQuery] = useState('')
  const [addingGroup, setAddingGroup] = useState(false)
  const [matches, setMatches] = useState<DingtalkDiscovery>()
  const request = useRef(0)
  const accountChanged = config.cli !== saved.cli || config.profile !== saved.profile
  useEffect(() => {
    setData(undefined); setMatches(undefined); setAddingGroup(false); setGroupQuery(''); setError(''); setBusy(false); request.current++
    return () => { request.current++ }
  }, [saved.cli, saved.profile])
  const refresh = async () => {
    const current = ++request.current
    setBusy(true); setError(''); setData(undefined)
    try {
      const { discovery } = await call('POST sources/:id/labels', { id: 'dingtalk' })
      if (!discovery) throw new Error(text('未返回钉钉列表，请重新读取。', 'No DingTalk list returned. Try loading again.'))
      if (current === request.current) setData(discovery)
    }
    catch (failure) { if (current === request.current) setError(errorText(failure)) }
    finally { if (current === request.current) setBusy(false) }
  }
  const findGroup = async () => {
    const query = groupQuery.trim()
    if (!query || accountChanged || busy) return
    const current = ++request.current
    setBusy(true); setError(''); setMatches(undefined)
    try {
      const { discovery } = await call('POST sources/:id/labels', { id: 'dingtalk', query: { q: query } })
      if (!discovery) throw new Error(text('未返回群搜索结果。', 'No group search results returned.'))
      if (current === request.current) setMatches(discovery)
    } catch (failure) { if (current === request.current) setError(errorText(failure)) }
    finally { if (current === request.current) setBusy(false) }
  }
  const groups = (config.chats ?? []) as { id: string; name?: string }[]
  const robots = data?.robots ?? []
  const selected = robots.find(robot => robot.id === config.botAppId && robot.robotCode === config.robotCode)
  return <div className="dt-dingtalk-sections">
    <section className="dt-dingtalk-section" aria-label={text('个人账号消息', 'Personal account messages')}>
    <div className="dt-subhead">
      <span className="dt-field-head">{text('个人账号消息（DWS）', 'Personal account messages (DWS)')}<InfoTip text={text('使用已登录的 DWS 账号；首次使用请在终端登录。其他组织可在高级设置指定 Profile，无需填写授权 ID。',
        'Uses the signed-in DWS account. Sign in in the terminal first; select another organization in Advanced. No authorization ID is needed.')} /></span>
      <Button variant="ghost" size="sm" icon={<Icon name="refresh" />} disabled={busy || accountChanged}
        aria-busy={busy} onClick={() => { void refresh() }}>
        {busy ? text('正在读取…', 'Loading…') : text('读取账号和机器人', 'Load account and robots')}
      </Button>
    </div>
    <p className="dt-hint">{accountChanged ? text('CLI 或组织配置已修改，请先保存再读取。', 'Save the CLI or organization changes before loading.')
      : data ? text(`当前账号：${data.account}`, `Current account: ${data.account}`)
      : text('点击右上角读取账号。', 'Load the account using the button above.')}</p>
    {error && <p className="dt-error" role="status">{text('读取失败：', 'Loading failed: ')}{error}</p>}
    {data?.warnings.map(warning => <p className="dt-hint" key={warning}>{warning}</p>)}
    <div className="dt-subhead">
      <span className="dt-field-head">{text('接收的群', 'Receiving groups')}<InfoTip text={text('通过个人账号接收所选群的新消息；跨群 @我和个人私聊单独设置。修改后请保存。',
      'Selected groups receive all new messages. Account mentions and personal direct messages have separate switches below. Loading lists does not change scope; save your selections.')} /> <span className="dt-count">{groups.length}</span></span>
      <Button variant="ghost" size="sm" disabled={accountChanged || busy}
        onClick={() => { setAddingGroup(!addingGroup); setGroupQuery(''); setMatches(undefined) }}>
        {addingGroup ? text('取消', 'Cancel') : text('＋ 添加', '+ Add')}
      </Button>
    </div>
    <ul className="dt-list dt-dingtalk-groups">{groups.map(group => <li key={group.id} className="dt-row">
      <span className="dt-row-main" title={group.id}>{data?.groups.find(item => item.id === group.id)?.name
        ?? group.name ?? text('已配置群（读取列表以核对名称）', 'Configured group (load the list to verify its name)')}</span>
      <Button variant="ghost" size="sm" icon={<Icon name="trash" />} aria-label={text('移除接收群', 'Remove receiving group')}
        onClick={() => onChange({ ...config, chats: groups.filter(item => item.id !== group.id) })} />
    </li>)}</ul>
    {!groups.length && <p className="dt-hint">{text('尚未添加接收群', 'No receiving groups added')}</p>}
    {addingGroup && <div className="dt-dingtalk-group-search">
    <div className="dt-row">
      <Input className="dt-row-main" aria-label={text('要添加的群名', 'Group name to add')} maxLength={100}
        placeholder={text('输入要添加的群名', 'Enter the group name to add')} value={groupQuery}
        disabled={accountChanged || busy} onChange={event => { setGroupQuery(event.target.value); setMatches(undefined) }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void findGroup() } }} />
      <Button variant="ghost" size="sm" disabled={!groupQuery.trim() || accountChanged || busy}
        onClick={() => { void findGroup() }}>{text('查找群', 'Find group')}</Button>
    </div>
    {matches && <div role="status">
      {matches.warnings.map(warning => <p className="dt-hint" key={warning}>{warning}</p>)}
      {!matches.groups.length && <p className="dt-hint">{text('没有找到群，请检查群名或当前组织。', 'No groups found. Check the name or organization.')}</p>}
      <ul className="dt-list dt-dingtalk-groups">{matches.groups.map(group => <li className="dt-row" key={group.id}>
        <span className="dt-row-main" title={group.id}>{group.name}</span>
        <Button variant="ghost" size="sm" disabled={accountChanged || busy || groups.some(item => item.id === group.id)}
          onClick={() => {
            if (!accountChanged && !busy && !groups.some(item => item.id === group.id)) {
              onChange({ ...config, chats: [...groups, group] })
              setAddingGroup(false); setGroupQuery(''); setMatches(undefined)
            }
          }}>
          {groups.some(item => item.id === group.id) ? text('已添加', 'Added') : text('添加', 'Add')}
        </Button>
      </li>)}</ul>
    </div>}
    </div>}
    {personalFields}
    </section>
    <section className="dt-dingtalk-section" aria-label={text('机器人会话', 'Robot conversations')}>
    <div className="dt-subhead">
      <span className="dt-field-head">{text('机器人会话', 'Robot conversations')}<InfoTip text={text('机器人私聊独立接收，不受上方个人账号的接收群和私聊开关影响。选择机器人并保存后开始接收其私聊，是否回复由下方开关控制。',
      'Robot private chats are received independently of personal account groups and direct-message switches. Selecting and saving a robot enables private-chat receiving; replies use the switches below.')} /></span>
      <Button variant="ghost" size="sm" icon={<Icon name="refresh" />} disabled={busy || accountChanged}
        aria-busy={busy} onClick={() => { void refresh() }}>
        {busy ? text('正在读取…', 'Loading…') : text('读取机器人', 'Load robots')}
      </Button>
    </div>
    {!data && <p className="dt-hint">{accountChanged
      ? text('请先保存 CLI 或组织配置，再读取机器人。', 'Save the CLI or organization changes before loading robots.')
      : text('请先点击本区域右上角“读取机器人”，再选择机器人。', 'Choose Load robots in this section before selecting a robot.')}</p>}
    <label className="dt-field">
      <span className="dt-field-head">{text('使用的机器人', 'Robot to use')}<InfoTip text={text('选择机器人后会自动填写对应应用信息；不会自动开启回复。应用列表只显示已发布且当前账号可读取的机器人。',
      'Choosing a robot fills its application details. Reply switches remain explicit. Lists include published robot applications readable by this account.')} /></span>
      <select className="dt-select" aria-label={text('使用的机器人', 'Robot to use')}
        disabled={busy || accountChanged || !data} value={selected?.id ?? (config.botAppId ? String(config.botAppId) : '')}
        onChange={event => {
          const robot = robots.find(item => item.id === event.target.value)
          onChange({ ...config, botAppId: robot?.id ?? '', robotCode: robot?.robotCode ?? '',
            ...(!robot ? { botReplies: false, replies: false } : {}) })
        }}>
        <option value="">{text('不使用机器人', 'Do not use a robot')}</option>
        {Boolean(config.botAppId) && !selected && <option value={String(config.botAppId)} disabled>
          {text('已配置机器人（请先点击“读取机器人”）', 'Configured robot (choose Load robots first)')}
        </option>}
        {robots.map(robot => <option key={robot.id} value={robot.id}>{robot.name}</option>)}
      </select>
    </label>
    {robotFields}
    </section>
  </div>
}

/** Shared explicit-only policy for the optional Sources. */
import { z } from 'zod'
import type { SourceKind } from './kind.ts'
export const explicitPolicy = (zh: string, en: string): NonNullable<SourceKind['policy']> => ({
  schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().optional() }).strict()).default([]) }).strict(),
  fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的用户', en: 'Allowed senders' }, columns: [
    { key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' } },
    { key: 'name', type: 'text', optional: true, label: { zh: '名字', en: 'Name' } },
  ] }], explicit: { zh, en },
  rows: () => [{ id: 'all', label: { zh: '全部接收的事件', en: 'All received events' },
    note: { zh: '接收与执行分开；观察模式只评估，不自动创建任务。', en: 'Observe mode assesses events without starting workers.' },
    cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } }],
})

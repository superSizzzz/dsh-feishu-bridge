/**
 * 跨模块共享的类型与最小工具函数。
 *
 * 这些结构直接对应 dsh 与飞书两侧的线上契约，改字段名要同时改两侧调用方：
 *  - QuestionItem / AnswerItem  对应 ctx.userQuestions 的请求与应答体
 *  - InboxEvent                 对应 `lark-cli event consume im.message.receive_v1`
 *                               输出的 NDJSON 行（content 字段已被 CLI 预解码为纯文本）
 */

/** 一条待用户回答的问题，来自 `user-questions/request`。 */
export interface QuestionItem {
  id: string
  question: string
  header?: string
  detail?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

/** 答案条目，回给 `userQuestions.ask()`。 */
export interface AnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/** 飞书入站消息事件（CLI 已把 content 解码成纯文本）。 */
export interface InboxEvent {
  type?: string
  event_id?: string
  message_id?: string
  chat_id?: string
  chat_type?: string
  message_type?: string
  sender_id?: string
  sender_type?: string
  create_time?: string
  content?: string
}

/** 一条改动文件的精简视图，来自 `ctx.workspaceChanges.summary()`。 */
export interface FileChange {
  path: string
  display: string
  added: number
  deleted: number
}

/** 一轮的改动汇总。 */
export interface ChangeSet {
  total: number
  added: number
  deleted: number
  files: FileChange[]
}

/** 插件用的最小日志面（对应 ctx.logger 的子集，便于单测替身）。 */
export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** 格式化时间戳为本地 `HH:mm` / `MM-DD HH:mm`。 */
export function stamp(date: Date, short = true): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (short) return clock
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`
}

/** 从任意值里安全取字符串。 */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 截断长文本，保留提示。 */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

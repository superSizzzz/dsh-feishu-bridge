/**
 * 事件流消费：起一个长驻 lark-cli 子进程，把 NDJSON 事件交给回调。
 *
 * 同一份实现服务两路订阅：
 *  - `im.message.receive_v1`  用户消息（入站对话）
 *  - `card.action.trigger`    卡片按钮回调（提问卡点选）
 *
 * 子进程契约（官方 lark-event skill 明文规定，必须照做）：
 *  - stderr 出现 `[event] ready event_key=…` 才算就绪，不能靠 sleep 猜。
 *  - stdout 是 NDJSON，一行一个事件；`content` 等字段已被 CLI 预解码。
 *  - 关闭 stdin 是约定的优雅退出信号；**绝不 kill -9**，
 *    否则会漏掉服务端订阅清理，重启时报 "subscription already exists"。
 */
import { createInterface } from 'node:readline'
import type { ChildProcess } from 'node:child_process'
import { spawnLarkStream } from './lark-cli.ts'
import type { CliOptions } from './lark-cli.ts'
import type { Logger } from './types.ts'

export type RawEvent = Record<string, unknown>

export interface InboxDeps {
  cli: CliOptions
  logger: Logger
  /** 订阅的 EventKey。 */
  eventKey: string
  /** 日志里用的名字，区分多路事件流。 */
  label: string
  onEvent: (event: RawEvent) => void
  /** 意外退出后的最大重启次数，默认 5。回调类订阅未开通时给个小值即可。 */
  maxRestarts?: number
}

const READY_MARKER = '[event] ready'
const RESTART_DELAY_MS = 5000
const MAX_RESTARTS = 5

export class Inbox {
  private child: ChildProcess | undefined
  private stopping = false
  private restart: NodeJS.Timeout | undefined
  private restarts = 0
  private ready = false
  private readonly deps: InboxDeps

  constructor(deps: InboxDeps) {
    this.deps = deps
  }

  get isReady(): boolean {
    return this.ready
  }

  /** 起常驻消费进程；已在运行则忽略。 */
  start(): void {
    if (this.child !== undefined) return
    this.stopping = false
    const { cli, eventKey, label } = this.deps
    const child = spawnLarkStream(['event', 'consume', eventKey, '--as', 'bot'], cli)
    this.child = child

    if (child.stdout !== null) {
      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => { this.consume(line) })
    }
    if (child.stderr !== null) {
      const diagnostics = createInterface({ input: child.stderr })
      diagnostics.on('line', (line) => {
        if (line.includes(READY_MARKER)) {
          this.ready = true
          this.restarts = 0
          this.deps.logger.info(`[feishu-bridge] ${label}事件流已就绪（${eventKey}）`)
          return
        }
        const text = line.trim()
        if (text.length > 0 && !text.includes('[event] exited')) {
          this.deps.logger.info(`[feishu-bridge] ${label}: ${text}`)
        }
      })
    }

    child.on('error', (error: Error) => {
      this.deps.logger.error(`[feishu-bridge] ${label}进程启动失败: ${error.message}`)
    })
    child.on('close', (code) => {
      this.child = undefined
      this.ready = false
      if (this.stopping) {
        this.deps.logger.info(`[feishu-bridge] ${label}事件流已停止`)
        return
      }
      this.deps.logger.warn(`[feishu-bridge] ${label}事件流意外退出 (code=${String(code)})`)
      this.scheduleRestart()
    })
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restart !== undefined) return
    if (this.restarts >= (this.deps.maxRestarts ?? MAX_RESTARTS)) {
      this.deps.logger.error(`[feishu-bridge] ${this.deps.label}连续重启失败，停止重试`)
      return
    }
    this.restarts += 1
    this.restart = setTimeout(() => {
      this.restart = undefined
      this.start()
    }, RESTART_DELAY_MS)
  }

  /** 解析一行 NDJSON。解析失败只跳过，不打断事件流。 */
  private consume(line: string): void {
    const text = line.trim()
    if (text.length === 0 || !text.startsWith('{')) return
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null) return
      this.deps.onEvent(parsed as RawEvent)
    } catch {
      this.deps.logger.warn(`[feishu-bridge] ${this.deps.label}收到无法解析的事件行，已跳过`)
    }
  }

  /** 优雅停止：先关 stdin，超时再 SIGTERM（绝不 kill -9）。 */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.restart !== undefined) {
      clearTimeout(this.restart)
      this.restart = undefined
    }
    const child = this.child
    if (child === undefined) return
    this.child = undefined
    this.ready = false
    try {
      child.stdin?.end()
    } catch {
      // stdin 可能已关闭，忽略。
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        resolve()
      }, 3000)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

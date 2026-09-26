/**
 * 桥接状态持久化。
 *
 * dsh 重启后要能恢复三件事：会话 ↔ 短码映射、当前默认投递目标、
 * 待回答问题的悬空卡片。写盘走「临时文件 + rename」，避免半截 JSON。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 一个 dsh 会话的桥接侧档案。 */
export interface SessionBinding {
  /** 4 位短码，用于飞书侧 `/use` 路由。 */
  code: string
  /**
   * 会话标题。优先用 dsh 的标题服务（`ctx.sessionTitle`），
   * 那个服务没挂载时退回「首条用户消息截一段」。
   */
  title?: string
  cwd: string
  lastTurn: number
  lastActiveAt: number
  startedAt: number
  turns: number
  toolCalls: number
  /** 最近一次 `workspace/changes` 事件的 seq，用于取改动清单。 */
  lastChangesSeq: number
  /** 最近一次已推送总结的 turn，防重复。 */
  lastSummaryTurn: number
  /**
   * 最近一次由模型主动播报（feishu_notify）的 turn。
   * 用来给 judge 兜底去重：同一个 turn 里模型已经说过，就不再问一遍。
   */
  lastNotifyTurn?: number
  /** 最近一条推送卡片的 message_id，用于节流窗口内就地更新。 */
  lastMessageId?: string
  lastMessageAt?: number
}

/** 一道待答问题登记的悬空卡片。 */
export interface PendingQuestion {
  sessionId?: string
  messageId?: string
  expiresAt: number
}

interface StateFile {
  version: number
  target: { kind: 'user' | 'chat'; id: string }
  activeSessionId?: string
  bindings: Record<string, SessionBinding>
  pending: Record<string, PendingQuestion>
  /** 上次启动时间，用来让上线问候知道「隔了多久又见面」。 */
  lastBootAt?: number
  /** 累计启动次数，问候可以拿它开玩笑。 */
  bootCount?: number
  /** 闲聊模式的多轮历史（结构由 chat.ts 定义，这里只做透传存储）。 */
  chat?: unknown
  /** 运行时覆盖项（飞书 `/config` 写的），优先级高于静态配置。 */
  overrides?: Record<string, string>
}

const EMPTY: StateFile = { version: 1, target: { kind: 'user', id: '' }, bindings: {}, pending: {} }

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 4 位短码：去掉易混字符，够用且好念。 */
function mintCode(): string {
  let out = ''
  for (let i = 0; i < 4; i += 1) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return out
}

export class Registry {
  private state: StateFile = structuredClone(EMPTY)
  private writing: Promise<void> = Promise.resolve()
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  /** 默认状态文件位置：`$DSH_HOME/dsh-feishu-bridge/state.json`。 */
  static defaultPath(configured: string): string {
    if (configured.length > 0) return configured
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    return join(home, 'dsh-feishu-bridge', 'state.json')
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null) {
        const raw = parsed as Partial<StateFile>
        this.state = {
          version: 1,
          target: raw.target ?? EMPTY.target,
          ...raw.activeSessionId === undefined ? {} : { activeSessionId: raw.activeSessionId },
          bindings: raw.bindings ?? {},
          pending: raw.pending ?? {},
          ...raw.lastBootAt === undefined ? {} : { lastBootAt: raw.lastBootAt },
          ...raw.bootCount === undefined ? {} : { bootCount: raw.bootCount },
          ...raw.chat === undefined ? {} : { chat: raw.chat },
          ...raw.overrides === undefined ? {} : { overrides: raw.overrides },
        }
      }
    } catch {
      // 首次运行没有状态文件；文件损坏也按空状态起步，桥接不该因此起不来。
      this.state = structuredClone(EMPTY)
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2)
    const target = this.filePath
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(target), { recursive: true })
      const tmp = `${target}.${process.pid}.tmp`
      await writeFile(tmp, snapshot, 'utf8')
      await rm(target, { force: true })
      await rename(tmp, target)
    }).catch(() => undefined)
    return this.writing
  }

  flush(): Promise<void> {
    return this.persist()
  }

  setTarget(kind: 'user' | 'chat', id: string): void {
    this.state.target = { kind, id }
    void this.persist()
  }

  /**
   * 记一次启动，并返回上一次的启动信息。
   * 上线问候可以据此说出「隔了多久又见面」而不是每次都念同一句。
   */
  noteBoot(now = Date.now()): { previousAt?: number; count: number } {
    const previousAt = this.state.lastBootAt
    this.state.lastBootAt = now
    this.state.bootCount = (this.state.bootCount ?? 0) + 1
    void this.persist()
    return {
      ...previousAt === undefined ? {} : { previousAt },
      count: this.state.bootCount,
    }
  }

  target(): { kind: 'user' | 'chat'; id: string } {
    return this.state.target
  }

  setActiveSession(sessionId: string): void {
    this.state.activeSessionId = sessionId
    void this.persist()
  }

  activeSessionId(): string | undefined {
    return this.state.activeSessionId
  }

  /** 状态文件路径（配置面板要展示给用户看）。 */
  location(): string {
    return this.filePath
  }

  /** 闲聊历史（由 ChatEngine 定义结构，registry 只负责存取）。 */
  chatStore(): unknown {
    return this.state.chat
  }

  setChatStore(store: unknown): void {
    this.state.chat = store
    void this.persist()
  }

  /** 运行时覆盖项，优先级高于静态配置（飞书 `/config` 写入）。 */
  overrides(): Record<string, string> {
    return this.state.overrides ?? {}
  }

  setOverride(key: string, value: string | undefined): void {
    const next = { ...this.state.overrides }
    if (value === undefined || value.length === 0) delete next[key]
    else next[key] = value
    this.state.overrides = next
    void this.persist()
  }

  /** 取会话档案，不存在则按工作区新建（并保证短码唯一）。 */
  ensure(sessionId: string, cwd: string, at = Date.now()): SessionBinding {
    const existing = this.state.bindings[sessionId]
    if (existing !== undefined) {
      if (cwd.length > 0) existing.cwd = cwd
      return existing
    }
    const used = new Set(Object.values(this.state.bindings).map((b) => b.code))
    let code = mintCode()
    while (used.has(code)) code = mintCode()
    const created: SessionBinding = {
      code,
      cwd,
      lastTurn: 0,
      lastActiveAt: at,
      startedAt: at,
      turns: 0,
      toolCalls: 0,
      lastChangesSeq: -1,
      lastSummaryTurn: -1,
    }
    this.state.bindings[sessionId] = created
    void this.persist()
    return created
  }

  get(sessionId: string): SessionBinding | undefined {
    return this.state.bindings[sessionId]
  }

  /** 按短码反查会话 id（`/use` 用）。 */
  findByCode(code: string): { sessionId: string; binding: SessionBinding } | undefined {
    const wanted = code.trim().toUpperCase()
    for (const [sessionId, binding] of Object.entries(this.state.bindings)) {
      if (binding.code === wanted) return { sessionId, binding }
    }
    return undefined
  }

  list(): Array<{ sessionId: string; binding: SessionBinding }> {
    return Object.entries(this.state.bindings)
      .map(([sessionId, binding]) => ({ sessionId, binding }))
      .sort((a, b) => b.binding.lastActiveAt - a.binding.lastActiveAt)
  }

  touch(sessionId: string, patch: Partial<SessionBinding>): void {
    const binding = this.state.bindings[sessionId]
    if (binding === undefined) return
    Object.assign(binding, patch)
    void this.persist()
  }

  addPending(questionId: string, pending: PendingQuestion): void {
    this.state.pending[questionId] = pending
    void this.persist()
  }

  takePending(questionId: string): PendingQuestion | undefined {
    const found = this.state.pending[questionId]
    if (found !== undefined) {
      delete this.state.pending[questionId]
      void this.persist()
    }
    return found
  }

  pendingCount(): number {
    return Object.keys(this.state.pending).length
  }

  /** 清掉过期的悬空问题登记。 */
  sweepPending(now = Date.now()): void {
    let dirty = false
    for (const [id, pending] of Object.entries(this.state.pending)) {
      if (pending.expiresAt <= now) {
        delete this.state.pending[id]
        dirty = true
      }
    }
    if (dirty) void this.persist()
  }
}

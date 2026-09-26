/**
 * 上报器：改动追踪 + 结束总结。
 *
 * 触发语义（对应 YG「只在关键时刻推」的要求）：
 *  - 阶段结论：由模型主动调 `feishu_notify`，或本轮确有文件改动时补一条精简卡
 *  - 结束：agent 转 idle 后静默一段时间没有新输入 → 判定这一轮工作收尾 → 推总结
 *  - 兜底：session 被销毁时立即补推一次
 *
 * 改动清单不自算，直接取 dsh 的 `ctx.workspaceChanges.summary()` ——
 * 它是 dsh 官方对「本轮改了什么」的权威口径（有 git 就含未提交改动）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { progressCard, summaryCard } from './render.ts'
import type { ChangeSet, Logger } from './types.ts'

interface SessionLike {
  id: string
  header?: { cwd?: string; origin?: string; delegationDepth?: number }
}

interface SessionEventLike {
  type?: string
  seq?: number
  data?: { turn?: number; id?: string; content?: unknown; source?: unknown }
}

/** 从一条 user 消息里取出纯文本（步骤组装时进历史的原文）。 */
function userTextOf(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const content = (data as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.join('\n').trim()
}

/** 从 `assistant/message` 事件里取出助手说的话。 */
function assistantTextOf(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  return userTextOf((data as { message?: unknown }).message)
}

/**
 * 把一次工具调用的参数压成一行线索，用来告诉文案模型「刚才具体在干什么」。
 * 只挑几个常见的定位字段，不把整段参数塞进去。
 */
function summarizeArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  const record = args as Record<string, unknown>
  const preferred = ['path', 'file_path', 'command', 'query', 'pattern', 'url', 'title', 'reason', 'text']
  const parts: string[] = []
  for (const key of preferred) {
    const value = record[key]
    if (typeof value !== 'string' || value.length === 0) continue
    parts.push(value.length > 70 ? `${value.slice(0, 70)}…` : value)
    if (parts.length >= 2) break
  }
  if (parts.length === 0) {
    for (const [, value] of Object.entries(record)) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 90) continue
      parts.push(value)
      break
    }
  }
  return parts.join(' · ')
}

interface ReporterDeps {
  logger: Logger
  enabled: () => boolean
  /** 每轮推送策略：always / changes / off。 */
  turnPush: () => string
  /** 是否在收到输入后先报「打算怎么干」。 */
  openPush: () => boolean
  /** 是否把模型的每段思考结论也推过来。 */
  thinkPush: () => boolean
  /** 是否在每段思考后判断有没有推断或结论值得同步。 */
  thinkingJudge: () => boolean
  /** 攒够多少字才值得让模型判断一次。 */
  pendingMinChars: () => number
  summaryPush: () => boolean
  /** idle 之后静默多久算「这轮结束了」。 */
  quietMs: number
  ensureBinding: (sessionId: string, cwd: string) => void
  touchBinding: (sessionId: string, patch: Record<string, unknown>) => void
  bindingOf: (sessionId: string) => { code: string; title?: string; cwd: string; turns: number; lastTurn: number; lastChangesSeq: number; lastSummaryTurn: number; lastNotifyTurn?: number; startedAt: number; toolCalls: number; lastMessageId?: string; lastMessageAt?: number } | undefined
  /** 读 dsh 的会话标题；服务没挂载或还没有标题时返回空串。 */
  sessionTitle: (session: unknown) => string
  markActive: (sessionId: string) => void
  resolveChanges: (sessionId: string, seq: number) => ChangeSet | undefined
  pushProgress: (sessionId: string, kind: string, card: string, force?: boolean) => Promise<{ messageId?: string }>
  /** 开工报告：收到输入后先说明打算怎么干。 */
  pushOpen: (sessionId: string, card: string) => Promise<{ messageId?: string }>
  /** 阶段思考：模型每说完一段就报一次「想到了什么」。 */
  pushThink: (sessionId: string, card: string) => Promise<{ messageId?: string }>
  pushSummary: (sessionId: string, reason: string) => Promise<{ delivered: boolean; detail: string }>
  /** 把素材写成人话；生成失败时必须返回兜底句，不能抛。 */
  compose: (sessionId: string, instruction: string, material: string, fallback: string) => Promise<string>
}

/**
 * 「这一阶段到底干成了什么」的判断准则。
 *
 * 两条都**从紧**：
 *  - 只报**已经做完**的事。「我打算…」「下一步…」不报 —— 那是开工报告的职责。
 *  - 没干成什么就先攒着，等积累出总结的空间再发，不为了报而报。
 *
 * 素材是**自上次播报以来累积的全部思考与动作**，不是眼前这一小段，
 * 所以模型看到的是「这一阶段」，而不是「这一句」。
 */
const JUDGE_THINKING_INSTRUCTION = [
  '下面是这一阶段累积的思考与动作记录。判断**实际完成了什么**值得同步给用户。',
  '',
  '该发：做成了事情 —— 改了代码、定位了问题、查清了事实、得出了可用的结论。',
  '不该发：',
  '- 只是在打算做、还在分析摸索、没有真正动手；',
  '- 做的事还零碎，没有形成总结的空间 —— 这时不要硬凑，攒着等后面一起说。',
  '',
  '如果不值得发，只回一个词：NONE',
  '如果值得发，用两三句说清**已经干了什么**：动作和对象都要落地。',
  '不要写「我准备」「我打算」「下一步」，不要复述过程，不要用「本轮」「综上」这类词。',
].join('\n')

/** 短于这个长度的助手输出不单独成卡（多半是「我先看看」这类过渡语）。 */
const MIN_THINK_CHARS = 20

/**
 * 用首条用户消息给会话起个短标题。
 * dsh 的标题服务没挂载时的兜底 —— 有名字总比只有代号好认。
 */
function clipTitle(text: string): string {
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  return firstLine.length <= 24 ? firstLine : `${firstLine.slice(0, 24)}…`
}

/**
 * 「这一轮算不算有成果」的判断准则。
 *
 * 要求模型**先判断再说话**：没成果只回一个词，有成果才写字。
 * 这样判断和写作合成一次调用，不用跑两趟模型。
 */
const JUDGE_INSTRUCTION = [
  '判断下面这一轮工作有没有**值得打断用户**的阶段性成果。',
  '判断标准：这条消息会不会改变他接下来的动作？会，就是有成果。',
  '如果**没有**成果（只是常规进度、还在摸索、暂时没结论），只回一个词：NONE',
  '如果**有**，用两三句把这个成果说清楚：做成了什么、结论是什么、下一步去哪。',
  '语气像同事报成果那样自然；不要罗列文件清单（卡片下方已经单列），不要用「本轮」「综上」「现将」这类词。',
].join('\n')

/** subagent 会话不计入桥接记录（与 dsh-workspace-changes 的 eligible 判定一致）。 */
function eligible(session: SessionLike): string | undefined {
  const header = session.header
  if (header === undefined) return undefined
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return undefined
  return header.cwd ?? ''
}

export class Reporter {
  private readonly quietTimers = new Map<string, NodeJS.Timeout>()
  /** 本轮用过的工具名（按调用顺序），进度卡要靠它说出「干了啥」。 */
  private readonly turnTools = new Map<string, string[]>()
  /** 已经报过开工的消息 id，避免同一轮重复开工。 */
  private readonly opened = new Set<string>()
  /** 这一轮调用过什么工具、带了什么线索（进度卡靠它说清「干了啥」）。 */
  private readonly turnCalls = new Map<string, string[]>()
  /** 最近几条助手结论，收尾汇报要靠它说出「结论是什么」。 */
  private readonly recentAssistant = new Map<string, string[]>()
  /** 最近几条用户原话，收尾汇报要靠它说出「这件事是什么」。 */
  private readonly recentUser = new Map<string, string[]>()
  /** 存 session 对象：标题服务按 session 读，不接受 id。 */
  private readonly sessions = new Map<string, unknown>()
  /** 已经判断过的思考片段（按会话分组，一轮一清），避免同一段被反复判断。 */
  private readonly judged = new Map<string, Set<string>>()
  /**
   * 自上次播报以来累积的思考。攒够总结的空间才报一次 ——
   * 这是「没干成什么就别发，等干得多了再说」的实现方式。
   */
  private readonly pending = new Map<string, string[]>()

  private readonly deps: ReporterDeps

  constructor(deps: ReporterDeps) {
    this.deps = deps
  }

  install(ctx: Context): void {
    ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
      const cwd = eligible(session)
      if (cwd === undefined) return
      this.deps.ensureBinding(session.id, cwd)
      const binding = this.deps.bindingOf(session.id)
      if (binding === undefined) return

      switch (event.type) {
        case 'user/message': {
          const source = (event.data?.source ?? {}) as { kind?: string }
          // 只认真正的用户输入；系统提示与工具注入不该触发开工报告。
          if (source.kind !== 'user') break
          const text = userTextOf(event.data)
          if (text.length === 0) break
          this.remember(this.recentUser, session.id, text)
          // 会话标题：优先问 dsh 的标题服务，没挂载就用这条消息截一段。
          this.sessions.set(session.id, session)
          if (binding.title === undefined || binding.title.length === 0) {
            const resolved = this.deps.sessionTitle(session).trim()
            const derived = resolved.length > 0 ? resolved : clipTitle(text)
            if (derived.length > 0) this.deps.touchBinding(session.id, { title: derived })
          }
          const key = typeof event.data?.id === 'string' ? event.data.id : `${session.id}:${binding.lastTurn}`
          if (this.opened.has(key)) break
          this.opened.add(key)
          void this.openCard(session.id, text, binding)
          break
        }
        case 'assistant/message': {
          const text = assistantTextOf(event.data)
          if (text.length === 0) break
          this.remember(this.recentAssistant, session.id, text)
          const turn = event.data?.turn ?? binding.lastTurn
          // 每段思考结束都判断一次：有推断或结论就同步（YG 要的粒度）。
          void this.judgeThinking(session.id, text, binding, turn)
          // thinkPush 打开时按原文机械推送，默认关。
          void this.thinkCard(session.id, text, binding, turn)
          break
        }
        case 'tool/call': {
          const call = event.data as { name?: unknown; arguments?: unknown } | undefined
          const toolName = typeof call?.name === 'string' ? call.name : ''
          if (toolName.length === 0) break
          const trace = summarizeArgs(call?.arguments)
          const list = this.turnCalls.get(session.id) ?? []
          list.push(trace.length > 0 ? `${toolName}（${trace}）` : toolName)
          this.turnCalls.set(session.id, list)
          break
        }
        case 'turn/start':
          this.clearQuiet(session.id)
          this.deps.markActive(session.id)
          this.turnTools.delete(session.id)
          this.turnCalls.delete(session.id)
          this.judged.delete(session.id)
          this.deps.touchBinding(session.id, { lastTurn: event.data?.turn ?? binding.lastTurn + 1, lastActiveAt: Date.now() })
          break
        case 'turn/end':
          this.deps.touchBinding(session.id, { turns: binding.turns + 1, lastActiveAt: Date.now() })
          // 改动清单是 turn-stopping 阶段落的，等一拍再推，确保拿到本轮 seq。
          setTimeout(() => {
            void this.maybeTurnCard(session.id, event.data?.turn ?? binding.lastTurn + 1)
          }, 400)
          break
        case 'tool/result':
          this.deps.touchBinding(session.id, { toolCalls: binding.toolCalls + 1 })
          break
        case 'workspace/changes':
          this.deps.touchBinding(session.id, { lastChangesSeq: event.seq ?? -1 })
          break
        default:
          break
      }
    })

    ctx.on('agent/status', (payload: { agent?: { session?: SessionLike }; status?: string }) => {
      const session = payload.agent?.session
      if (session === undefined) return
      if (eligible(session) === undefined) return
      if (payload.status === 'running') {
        this.clearQuiet(session.id)
        this.deps.markActive(session.id)
        return
      }
      this.scheduleQuiet(session.id)
    })

    // 采集本轮用过的工具：进度卡要说出「干了啥」，而不只是报文件数。
    ctx.on('tools/result', (exec: { name?: string; agent?: { session?: SessionLike } }) => {
      const session = exec.agent?.session
      if (session === undefined || eligible(session) === undefined) return
      const toolName = typeof exec.name === 'string' ? exec.name : ''
      if (toolName.length === 0) return
      const list = this.turnTools.get(session.id) ?? []
      list.push(toolName)
      this.turnTools.set(session.id, list)
    })

    ctx.on('session/disposed', (session: SessionLike) => {
      if (eligible(session) === undefined) return
      this.clearQuiet(session.id)
      // 会话没了，累积与去重表也留着没意义。
      this.pending.delete(session.id)
      this.judged.delete(session.id)
      this.sessions.delete(session.id)
      void this.deps.pushSummary(session.id, 'session-disposed')
    })
  }

  /** 留最近几条同类文本，供汇报素材使用。 */
  private remember(store: Map<string, string[]>, sessionId: string, text: string, limit = 4): void {
    const list = store.get(sessionId) ?? []
    list.push(text.length > 400 ? `${text.slice(0, 400)}…` : text)
    while (list.length > limit) list.shift()
    store.set(sessionId, list)
  }

  private clearQuiet(sessionId: string): void {
    const timer = this.quietTimers.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.quietTimers.delete(sessionId)
  }

  /** idle 后静默一段时间；期间有新 turn 会被 clearQuiet 取消。 */
  private scheduleQuiet(sessionId: string): void {
    this.clearQuiet(sessionId)
    const timer = setTimeout(() => {
      this.quietTimers.delete(sessionId)
      void this.deps.pushSummary(sessionId, 'idle-settled')
    }, this.deps.quietMs)
    timer.unref?.()
    this.quietTimers.set(sessionId, timer)
  }

  /**
   * 开工报告：收到你的输入后，先说明「我打算怎么干」。
   *
   * 这一条的素材只有用户原话和会话坐标 —— 此刻模型还没开始干活，
   * 所以文案是「打算做什么」而不是「做了什么」，不编造未发生的结论。
   */
  private async openCard(
    sessionId: string,
    userText: string,
    binding: { cwd: string; code: string; title?: string; lastTurn: number; lastNotifyTurn?: number },
  ): Promise<void> {
    if (!this.deps.enabled() || !this.deps.openPush()) return
    const quoted = userText.length > 600 ? `${userText.slice(0, 600)}…` : userText
    const material = [
      `你（用户）刚说的：${quoted}`,
      `工作区：${binding.cwd}`,
      `会话：#${binding.code}`,
    ].join('\n')
    const body = await this.deps.compose(
      sessionId,
      '用户刚给 dsh 提了个要求。用中文写一两句说明**接下来打算怎么干**：要做什么、从哪儿入手。'
        + '像同事应声那样自然，别用「收到」「好的」「马上」这类客套开场，也别承诺你还不确定的结果。',
      material,
      `这就去看看你说的这件事：${quoted.length > 60 ? `${quoted.slice(0, 60)}…` : quoted}`,
    )
    const card = progressCard({
      title: '准备开工',
      body,
      cwd: binding.cwd,
      code: binding.code,
      sessionTitle: binding.title,
      turn: binding.lastTurn,
      at: this.stamp(),
    })
    await this.deps.pushOpen(sessionId, card)
  }

  /**
   * 每段思考结束后跑一次：把这段攒起来，再看攒下的这一阶段值不值得报。
   *
   * **累积**是这个判断的关键 —— 素材是自上次播报以来的全部思考与动作，
   * 所以「刚起个头」会被判为没总结空间（继续攒），而「真干完几件事」
   * 才会成一条总结。判断和写作合成一次调用：`NONE` 表示继续攒。
   *
   * 生成失败时返回空串 → 不清空累积、静默，下次再判。
   */
  private async judgeThinking(
    sessionId: string,
    text: string,
    binding: { cwd: string; code: string; title?: string; lastTurn: number; lastNotifyTurn?: number },
    turn: number,
  ): Promise<void> {
    if (!this.deps.enabled() || !this.deps.thinkingJudge()) return
    const trimmed = text.trim()
    if (trimmed.length < MIN_THINK_CHARS) return

    // 同一段只进累积一次（事件可能重放，长文本也可能被拆成多次投递）。
    const seen = this.judged.get(sessionId) ?? new Set<string>()
    const key = trimmed.slice(0, 96)
    if (seen.has(key)) return
    seen.add(key)
    this.judged.set(sessionId, seen)

    const bucket = this.pending.get(sessionId) ?? []
    bucket.push(trimmed)
    this.pending.set(sessionId, bucket)

    // 攒得太少就别浪费一次判断：连一段话都没积起来，谈不上「总结的空间」。
    const gathered = bucket.join('\n\n')
    if (gathered.length < this.deps.pendingMinChars()) return

    const calls = this.turnCalls.get(sessionId) ?? []
    const material = [
      gathered,
      ...calls.length === 0 ? [] : [`这一阶段用过的工具：${calls.slice(-20).join('；')}`],
    ].join('\n\n')

    const verdict = (await this.deps.compose(
      sessionId,
      JUDGE_THINKING_INSTRUCTION,
      material,
      '',
    )).trim()
    // 报不报都看模型：NONE 就保留累积，等后面干得多了再一起说。
    if (verdict.length === 0 || /^NONE\b/i.test(verdict)) return
    this.pending.delete(sessionId)

    const card = progressCard({
      title: `这一阶段干完了什么 · 第 ${turn} 轮`,
      body: verdict,
      cwd: binding.cwd,
      code: binding.code,
      sessionTitle: binding.title,
      turn,
      at: this.stamp(),
    })
    await this.deps.pushThink(sessionId, card)
    this.deps.touchBinding(sessionId, { lastNotifyTurn: turn })
    this.deps.logger.info(`[feishu-bridge] 第 ${turn} 轮的阶段总结已推送`)
  }

  /**
   * 阶段思考卡：模型每说完一段话就报一次。
   *
   * 素材就是它的原话，不再过一遍模型 —— 二次改写只会把结论磨平。
   * 太短的（「我先看看」这类过渡语）直接跳过，它们不构成阶段结论。
   */
  private async thinkCard(
    sessionId: string,
    text: string,
    binding: { cwd: string; code: string; title?: string; lastTurn: number; lastNotifyTurn?: number },
    turn: number,
  ): Promise<void> {
    if (!this.deps.enabled() || !this.deps.thinkPush()) return
    const trimmed = text.trim()
    if (trimmed.length < MIN_THINK_CHARS) return
    const card = progressCard({
      title: `想到了点东西 · 第 ${turn} 轮`,
      body: trimmed,
      cwd: binding.cwd,
      code: binding.code,
      sessionTitle: binding.title,
      turn,
      at: this.stamp(),
    })
    await this.deps.pushThink(sessionId, card)
  }

  /**
   * 「这一轮有没有值得报的成果」由模型判断，没成果就安静。
   *
   * 为什么不由主模型自己调工具：它一旦钻进任务就不记得调了。
   * 这里改成每轮结束主动问一次 —— 一次调用同时完成「判断」和「写作」：
   * 回 `NONE` 表示没成果；否则它的输出就是成果本身。
   *
   * 生成失败时返回空串 → 直接静默。宁可漏报，也不要拿兜底句糊弄。
   */
  private async judgeCard(
    sessionId: string,
    turn: number,
    binding: { cwd: string; code: string; title?: string; lastTurn: number; lastNotifyTurn?: number },
    changes: ChangeSet | undefined,
  ): Promise<void> {
    // 模型这一轮已经主动播报过了，就别再问一遍 —— 否则同一个成果会推两次。
    if (binding.lastNotifyTurn !== undefined && binding.lastNotifyTurn >= turn) return
    const verdict = (await this.deps.compose(
      sessionId,
      JUDGE_INSTRUCTION,
      this.turnMaterial(sessionId, binding, changes, turn),
      '',
    )).trim()
    if (verdict.length === 0 || /^NONE\b/i.test(verdict)) return
    const card = progressCard({
      title: `第 ${turn} 轮的成果`,
      body: verdict,
      cwd: binding.cwd,
      code: binding.code,
      sessionTitle: binding.title,
      turn,
      at: this.stamp(),
      ...changes === undefined ? {} : { changes },
    })
    await this.deps.pushThink(sessionId, card)
    this.deps.logger.info(`[feishu-bridge] 第 ${turn} 轮判定为有成果，已推送`)
  }

  /** turn 结束后的推送。`turnPush` 决定策略：judge（默认）/ always / changes / off。 */
  async maybeTurnCard(sessionId: string, turn: number): Promise<void> {
    if (!this.deps.enabled()) return
    const policy = this.deps.turnPush()
    if (policy === 'off') return
    const binding = this.deps.bindingOf(sessionId)
    if (binding === undefined || binding.code.length === 0) return
    const changes = this.deps.resolveChanges(sessionId, binding.lastChangesSeq)
    if (policy === 'judge') {
      await this.judgeCard(sessionId, turn, binding, changes)
      return
    }
    if (policy === 'changes' && (changes === undefined || changes.total === 0)) return
    if (policy === 'always' && binding.turns <= 1 && (changes === undefined || changes.total === 0)) {
      // 第一轮且什么都没改：不必为聊天式对话起一张卡。
      return
    }
    const hasChanges = changes !== undefined && changes.total > 0
    const body = await this.deps.compose(
      sessionId,
      '这是 dsh 刚干完的一轮活。用中文写一两句，说清这一轮**做了什么**：'
        + '用了哪些手段、动没动文件、得出的结论是什么。'
        + '语气像同事随口汇报，轻松自然；不要罗列工具名清单，不要「本轮」「综上」「现将」这类词。',
      this.turnMaterial(sessionId, binding, changes, turn),
      hasChanges
        ? `这一轮动了 ${changes.total} 个文件，细账在下面～`
        : '这一轮主要是动了动脑子，没落文件。',
    )
    const card = progressCard({
      title: `第 ${turn} 轮`,
      body,
      cwd: binding.cwd,
      code: binding.code,
      sessionTitle: binding.title,
      turn,
      at: this.stamp(),
      ...changes === undefined ? {} : { changes },
    })
    // force：开工卡刚占用了本会话的「上一条卡片」，阶段卡必须独立发出而不是被合并掉。
    await this.deps.pushProgress(sessionId, `turn-${turn}`, card, true)
  }

  /** 给进度卡文案模型的事实素材。 */
  private turnMaterial(
    sessionId: string,
    binding: { cwd: string },
    changes: ChangeSet | undefined,
    turn: number,
  ): string {
    const tools = this.turnTools.get(sessionId) ?? []
    const calls = this.turnCalls.get(sessionId) ?? []
    const lines = [`第 ${turn} 轮`, `工作区：${binding.cwd}`, `本轮工具调用 ${tools.length} 次`]
    const users = this.recentUser.get(sessionId) ?? []
    if (users.length > 0) lines.push(`这一轮用户说的是：${users[users.length - 1]}`)
    const assistant = this.recentAssistant.get(sessionId) ?? []
    if (assistant.length > 0) lines.push(`dsh 这一轮给出的结论：${assistant[assistant.length - 1]}`)
    if (calls.length > 0) {
      lines.push('具体动作（按顺序，最多 10 条）：')
      for (const call of calls.slice(-10)) lines.push(`- ${call}`)
    }
    if (changes !== undefined && changes.total > 0) {
      lines.push(`改动：${changes.total} 个文件，新增 ${changes.added} 行，删除 ${changes.deleted} 行`)
      for (const file of changes.files.slice(0, 12)) lines.push(`  ${file.display}`)
    } else {
      lines.push('改动：没有文件改动')
    }
    return lines.join('\n')
  }

  /** 汇总给文案模型的事实素材（只给事实，不含措辞）。 */
  material(sessionId: string): string {
    const binding = this.deps.bindingOf(sessionId)
    if (binding === undefined) return ''
    const changes = this.deps.resolveChanges(sessionId, binding.lastChangesSeq)
    const lines = [
      `工作区：${binding.cwd}`,
      `轮次：${binding.turns} turn，工具调用 ${binding.toolCalls} 次`,
      `起止：${this.stamp(new Date(binding.startedAt))} → ${this.stamp()}`,
    ]
    // 用户提过什么、dsh 得出过什么结论 —— 没有这两样，模型只能写出空话。
    const users = this.recentUser.get(sessionId) ?? []
    if (users.length > 0) {
      lines.push('用户这段时间提的要求（旧到新）：')
      for (const text of users) lines.push(`- ${text}`)
    }
    const assistant = this.recentAssistant.get(sessionId) ?? []
    if (assistant.length > 0) {
      lines.push('dsh 最近给出的结论：')
      for (const text of assistant.slice(-4)) lines.push(`- ${text}`)
    }
    const calls = this.turnCalls.get(sessionId) ?? []
    if (calls.length > 0) {
      lines.push(`最后一轮的动作（${calls.length} 次）：${calls.slice(-20).join('；')}`)
    }
    if (changes !== undefined && changes.total > 0) {
      lines.push(`改动：${changes.total} 个文件，新增 ${changes.added} 行，删除 ${changes.deleted} 行`)
      for (const file of changes.files.slice(0, 20)) {
        lines.push(`  ${file.display}  +${file.added} −${file.deleted}`)
      }
    } else {
      lines.push('改动：没有文件改动')
    }
    return lines.join('\n')
  }

  /** 组装工作汇报卡。narrative 由调用方用模型现写，这里只做拼装。 */
  buildSummary(sessionId: string, narrative: string): { card: string; title: string } | undefined {
    const binding = this.deps.bindingOf(sessionId)
    if (binding === undefined) return undefined
    const changes = this.deps.resolveChanges(sessionId, binding.lastChangesSeq)
    const card = summaryCard({
      title: '这一轮的汇报',
      narrative,
      cwd: binding.cwd,
      code: binding.code,
      sessionTitle: binding.title,
      startedAt: this.stamp(new Date(binding.startedAt)),
      endedAt: this.stamp(),
      turns: binding.turns,
      toolCalls: binding.toolCalls,
      ...changes === undefined ? {} : { changes },
    })
    return { card, title: '这一轮的汇报' }
  }

  dispose(): void {
    for (const timer of this.quietTimers.values()) clearTimeout(timer)
    this.quietTimers.clear()
  }

  private stamp(at = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(at.getHours())}:${pad(at.getMinutes())}`
  }
}

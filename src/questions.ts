/**
 * 提问桥：网页优先，网页无人应答才走飞书。
 *
 * 实现要点（决策见 PLAN.md 6.3）：
 *  - 监听器用 `prepend: true` 抢在 dsh 的 Web 转发器之前，这样 `next()`
 *    恰好把请求送进 Web 通道，我们拿到的是"网页那一侧的结果"。
 *  - 永远先调 `next()`：排在前就等网页结果，排在后就根本轮不到我们，
 *    顺序依赖被这个写法消掉。
 *  - 宽限期内网页答了 → 立刻返回，飞书零打扰。
 *  - 网页没有 answerer（`NO_PROVIDER`）→ 直接走飞书，零延迟。
 *  - 两边都挂着 → 飞书卡片等一段时间；到点不答也不拒绝，
 *    而是回落到继续等网页，绝不把 agent 卡死。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Logger, QuestionItem, AnswerItem } from './types.ts'
import type { Outbox } from './outbox.ts'
import type { Registry } from './registry.ts'
import { noticeCard, questionCard } from './render.ts'

interface AskRequest {
  questions: QuestionItem[]
  agent?: { id: string; session?: { id: string; header?: { cwd?: string } } }
  signal?: AbortSignal
}

interface Ticket {
  id: string
  sessionId: string
  questions: QuestionItem[]
  collected: Map<string, AnswerItem>
  messageId?: string
  resolve: (answers: AnswerItem[]) => void
  timer?: NodeJS.Timeout
}

type Settled<T> = { kind: 'settled'; value: T } | { kind: 'rejected'; error: unknown } | { kind: 'pending' }

/** 等 promise 在窗口内 settle，或报告它仍然挂着。 */
function raceSettle<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve({ kind: 'pending' }) }, ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve({ kind: 'settled', value }) },
      (error: unknown) => { clearTimeout(timer); resolve({ kind: 'rejected', error }) },
    )
  })
}

export interface QuestionDeps {
  outbox: Outbox
  registry: Registry
  logger: Logger
  graceMs: number
  timeoutMs: number
  enabled: () => boolean
}

export class QuestionBridge {
  private readonly tickets = new Map<string, Ticket>()
  private counter = 0

  private readonly deps: QuestionDeps

  constructor(deps: QuestionDeps) {
    this.deps = deps
  }

  install(ctx: Context): void {
    ctx.on('user-questions/request', (request: AskRequest, next: () => Promise<{ answers: AnswerItem[] }>) => {
      return this.handle(request, next)
    }, { prepend: true })
  }

  private async handle(request: AskRequest, next: () => Promise<{ answers: AnswerItem[] }>): Promise<{ answers: AnswerItem[] }> {
    if (!this.deps.enabled() || request.signal?.aborted === true) return next()

    // 1) 先把机会让给下游：dsh 的 Web 转发器就在下一环。
    const web = Promise.resolve().then(() => next())
    web.catch(() => undefined)

    // 2) 宽限期：网页接了并且人在电脑前 → 直接用它，飞书完全不打扰。
    const quick = await raceSettle(web, this.deps.graceMs)
    if (quick.kind === 'settled') return quick.value

    // 3) 网页在但没人在看（或压根没有 answerer）→ 飞书介入。
    const ticket = await this.open(request)
    if (ticket === undefined) {
      // 飞书通道不可用，退回原有的单通道行为。
      if (quick.kind === 'rejected') throw quick.error
      return web
    }

    const raced = await Promise.race([
      web.then((answer) => ({ from: 'web' as const, answer }), () => undefined),
      ticket.answer.then((answer) => ({ from: 'feishu' as const, answer })),
    ])
    if (raced === undefined || raced.from === 'web') {
      // 网页（或它自己的失败）先落地：把飞书卡片改成已作答，别留悬空卡。
      await this.retire(ticket, '✅ 你在网页那边答过啦，这张卡收工')
      if (raced === undefined) return web
      return raced.answer
    }
    this.close(ticket)
    return { answers: raced.answer }
  }

  /** 发提问卡并登记等待。飞书通道不可用时返回 undefined。 */
  private async open(request: AskRequest): Promise<(Ticket & { answer: Promise<AnswerItem[]> }) | undefined> {
    const target = this.deps.registry.target()
    if (target.id.length === 0) return undefined

    const sessionId = request.agent?.session?.id ?? ''
    const binding = sessionId.length === 0 ? undefined : this.deps.registry.ensure(sessionId, request.agent?.session?.header?.cwd ?? '')
    const cwd = binding?.cwd ?? process.cwd()
    const code = binding?.code ?? '----'
    const now = new Date()

    this.counter += 1
    const id = `q${now.getTime().toString(36)}${this.counter}`
    let resolveAnswer: (answers: AnswerItem[]) => void = () => undefined
    const answer = new Promise<AnswerItem[]>((resolve) => { resolveAnswer = resolve })

    const ticket: Ticket & { answer: Promise<AnswerItem[]> } = {
      id,
      sessionId,
      questions: request.questions,
      collected: new Map(),
      resolve: resolveAnswer,
      answer,
    }

    const card = questionCard({
      questions: request.questions,
      cwd,
      code,
      at: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      minutes: Math.max(1, Math.round(this.deps.timeoutMs / 60000)),
    })
    const messageId = await this.deps.outbox.reply(card)
    if (messageId === undefined) {
      this.deps.logger.warn('[feishu-bridge] 提问卡发送失败，交回网页通道')
      return undefined
    }
    ticket.messageId = messageId
    this.tickets.set(id, ticket)
    this.deps.registry.addPending(id, {
      ...sessionId.length === 0 ? {} : { sessionId },
      messageId,
      expiresAt: now.getTime() + this.deps.timeoutMs,
    })

    // 到点不答：卡片标记失效、撤登记，但**不 resolve** —— 让上层的竞速
    // 自然回落到继续等网页，agent 不会被卡死也不会报错。
    ticket.timer = setTimeout(() => {
      this.tickets.delete(id)
      this.deps.registry.takePending(id)
      void this.deps.outbox.update(messageId, noticeCard('⌛ 等太久啦，先交回网页那边继续等', '这张卡先收起来', 'grey'))
      this.deps.logger.info('[feishu-bridge] 提问在飞书侧超时，回落到网页通道')
    }, this.deps.timeoutMs)

    return ticket
  }

  private close(ticket: Ticket): void {
    if (ticket.timer !== undefined) clearTimeout(ticket.timer)
    this.tickets.delete(ticket.id)
    this.deps.registry.takePending(ticket.id)
  }

  private async retire(ticket: Ticket, text: string): Promise<void> {
    this.close(ticket)
    if (ticket.messageId !== undefined) {
      await this.deps.outbox.update(ticket.messageId, noticeCard(text, '搞定啦', 'green'))
    }
  }

  /**
   * 处理一条来自飞书的文本回答（按「当前未答的第一题」匹配）。
   * @returns true 表示这条消息被当作答案消费掉了（不再投给会话）。
   */
  answer(text: string): boolean {
    if (this.tickets.size === 0) return false
    const ticket = [...this.tickets.values()].reverse()[0]
    const index = this.nextUnanswered(ticket)
    if (index < 0) return false
    const question = ticket.questions[index]
    return this.record(ticket, question.id, this.interpret(text, question))
  }

  /**
   * 处理卡片按钮回调：按 qid 精确定位问题，不依赖顺序。
   * @returns true 表示这次点击被消费。
   */
  answerByLabel(qid: string, label: string): boolean {
    for (const ticket of [...this.tickets.values()].reverse()) {
      const question = ticket.questions.find((q) => q.id === qid)
      if (question === undefined) continue
      if (ticket.collected.has(qid)) return false
      return this.record(ticket, qid, { id: qid, selected: [label] })
    }
    return false
  }

  /** 记下一题的答案；答完就 resolve，没答完就把卡片更新成进度。 */
  private record(ticket: Ticket, qid: string, answer: AnswerItem): boolean {
    ticket.collected.set(qid, answer)
    const remaining = this.nextUnanswered(ticket)
    if (remaining >= 0) {
      const left = ticket.questions.filter((q) => !ticket.collected.has(q.id)).map((q) => q.question).join('；')
      if (ticket.messageId !== undefined) {
        const noted = answer.custom ?? answer.selected.join('、')
        void this.deps.outbox.update(ticket.messageId, noticeCard(`记下啦：**${noted}**\n还差：${left}`, '还差一个答案', 'yellow'))
      }
      return true
    }

    if (ticket.timer !== undefined) clearTimeout(ticket.timer)
    this.tickets.delete(ticket.id)
    this.deps.registry.takePending(ticket.id)
    const answers = ticket.questions.map((q) => ticket.collected.get(q.id) ?? { id: q.id, selected: [] })
    ticket.resolve(answers)
    this.deps.logger.info('[feishu-bridge] 已用飞书侧答案回答问题')
    return true
  }

  /** 找到第一个还没答案的问题下标。 */
  private nextUnanswered(ticket: Ticket): number {
    return ticket.questions.findIndex((q) => !ticket.collected.has(q.id))
  }

  /** 把一条文本解释成答案：先试编号，再试选项 label，最后当自由文本。 */
  private interpret(text: string, question: QuestionItem): AnswerItem {
    const options = question.options ?? []
    const byIndex = /^(\d+)$/.exec(text)
    if (byIndex !== null && options.length > 0) {
      const idx = Number(byIndex[1]) - 1
      if (idx >= 0 && idx < options.length) {
        const label = options[idx].label
        return question.multiSelect === true
          ? { id: question.id, selected: [label] }
          : { id: question.id, selected: [label] }
      }
    }
    const matched = options.find((o) => o.label === text)
    if (matched !== undefined) return { id: question.id, selected: [matched.label] }
    return options.length > 0
      ? { id: question.id, selected: [], custom: text }
      : { id: question.id, selected: [], custom: text }
  }

  /** 会话取消时清理它的悬空提问卡。 */
  async cancelForSession(sessionId: string): Promise<void> {
    for (const ticket of [...this.tickets.values()]) {
      if (ticket.sessionId !== sessionId) continue
      await this.retire(ticket, '⛔ 会话被叫停了，这个问题先作废')
    }
  }
}

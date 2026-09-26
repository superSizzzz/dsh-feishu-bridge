/**
 * 闲聊模式：不经过 dsh 的独立对话通道。
 *
 * 设计取舍：
 *  - **复用 dsh 的 `ctx.llm`，不自己接 HTTP**：provider 路由与凭据都由 dsh 管，
 *    插件不需要持有任何 API key。这正好满足「apikey 默认用 dsh 的」。
 *  - 但**完全不碰会话**：这里没有 agent、没有 session、没有工具，只有一段
 *    多轮对话，跟普通聊天客户端一样。聊过的内容不会进 dsh 的历史。
 *  - 历史自己维护 + 落盘，切换模式或重启都还在。
 */
import type { LlmLike } from './writer.ts'
import type { Logger } from './types.ts'

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}

/** 落盘用的历史结构。 */
export interface ChatStore {
  histories: Record<string, ChatTurn[]>
}

/**
 * 闲聊时的**行为**约束。
 *
 * 这里刻意不含身份 —— 身份统一由 `config.persona` 提供：闲聊沿用工作模式
 * 同一套人设，只是行为上从「干活」切成「聊天」。两处若各写一套身份，
 * 用户会觉得跟两个人在说话。
 */
const CHAT_BEHAVIOR = [
  '现在是闲聊模式：用户只是想跟你聊天，不是在派活。',
  '- 回复短一点，一两句话就够，别写成小作文，也别列标题和条目；',
  '- 不用给方案、不用列下一步，自然接话就行；',
  '- 话题聊到工作上也可以接，但别主动要求去改代码或跑命令。',
].join('\n')

export interface ChatDeps {
  llm: () => LlmLike | undefined
  logger: Logger
  /** 闲聊用的系统提示；空则用内置。 */
  systemPrompt: () => string
  /** 闲聊模型路由；空则用部署默认。 */
  route: () => { provider?: string; model?: string }
  /** 保留多少轮（一问一答算两轮）上下文。 */
  maxTurns: () => number
  /** 人设注入，与飞书其它文案共用。 */
  persona: () => string
  /** 历史变化时回调，便于调用方落盘。 */
  onChange?: () => void
}

export class ChatEngine {
  private readonly deps: ChatDeps
  private histories = new Map<string, ChatTurn[]>()

  constructor(deps: ChatDeps) {
    this.deps = deps
  }

  /** 从持久化状态装载历史。 */
  load(store: ChatStore | undefined): void {
    this.histories = new Map()
    for (const [key, turns] of Object.entries(store?.histories ?? {})) {
      if (Array.isArray(turns)) this.histories.set(key, turns.filter(isTurn))
    }
  }

  /** 导出用于落盘。 */
  dump(): ChatStore {
    return { histories: Object.fromEntries(this.histories.entries()) }
  }

  size(key: string): number {
    return this.histories.get(key)?.length ?? 0
  }

  reset(key: string): void {
    this.histories.delete(key)
    this.deps.onChange?.()
  }

  /**
   * 回一轮闲聊。
   * @param key 会话键（私聊场景就是 chat id）。
   * @param text 用户这句话。
   * @returns 助手的回复文本。
   * @throws 当模型不可用或调用失败时抛出，由调用方决定怎么提示。
   */
  async reply(key: string, text: string): Promise<string> {
    const llm = this.deps.llm()
    if (llm === undefined) throw new Error('当前没有可用的模型服务（ctx.llm 未就绪）')
    const route = this.deps.route()
    if (route.provider === undefined || route.model === undefined) {
      throw new Error('没有可用的模型路由，请在配置里指定 chatProvider / chatModel')
    }

    const persona = this.deps.persona().trim()
    const system = buildSystem(this.deps.systemPrompt(), persona)
    const history = this.histories.get(key) ?? []
    const limit = Math.max(2, this.deps.maxTurns())

    const wire = [{
      role: 'user',
      content: [{ type: 'text', text: buildPrompt(system, history.slice(-limit), text) }],
    }]

    let answer = ''
    const seen = new Map<string, number>()
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      messages: wire as never,
      maxTokens: 3000,
      temperature: 0.9,
    })
    for await (const chunk of stream) {
      const kind = typeof chunk.type === 'string' ? chunk.type : 'unknown'
      seen.set(kind, (seen.get(kind) ?? 0) + 1)
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') answer += chunk.text
      if (chunk.type === 'finish') break
    }
    answer = answer.trim()
    if (answer.length === 0) {
      // 空回复必须带着证据报出来，否则只能靠猜。
      const received = [...seen.entries()].map(([name, count]) => `${name}×${count}`).join(', ')
      throw new Error(
        `模型返回了空回复（${route.provider}/${route.model}；收到 ${received.length > 0 ? received : '零个 chunk'}）`,
      )
    }

    const next = [...history, { role: 'user' as const, text }, { role: 'assistant' as const, text: answer }]
    this.histories.set(key, next.slice(-limit * 2))
    this.deps.onChange?.()
    return answer
  }
}

function isTurn(value: unknown): value is ChatTurn {
  if (typeof value !== 'object' || value === null) return false
  const turn = value as { role?: unknown; text?: unknown }
  return (turn.role === 'user' || turn.role === 'assistant') && typeof turn.text === 'string'
}

/**
 * 把 system、历史、当前输入压成**一条 user 消息**。
 *
 * 为什么不直接用原生的 system + 多轮消息结构：实测这条 adapter 通路对含
 * system 的请求会返回空内容，而「单条 user」这种结构已被上线问候验证可用。
 * 聊天场景把对话记录写成文本，模型照样能读出上下文。
 */
function buildPrompt(system: string, history: ChatTurn[], text: string): string {
  const lines = [system, '']
  if (history.length > 0) {
    lines.push('之前的对话记录：')
    for (const turn of history) {
      lines.push(`${turn.role === 'user' ? '用户' : '你'}：${turn.text}`)
    }
    lines.push('')
  }
  lines.push(`用户刚刚说：${text}`, '')
  lines.push('直接回应用户刚说的这句话。只写回复内容本身，不要写「你：」这类前缀，也不要复述上面的记录。')
  return lines.join('\n')
}

/**
 * 拼闲聊用的 system。
 *
 * 优先级刻意设计成「人设先行」：闲聊和工作共用同一套角色，
 * 差别只在行为约束，所以 persona 永远是主体，行为要求是附加段落。
 */
function buildSystem(configured: string, persona: string): string {
  const explicit = configured.trim()
  if (explicit.length > 0) {
    return persona.length > 0 ? `${explicit}\n\n口吻：${persona}` : explicit
  }
  return persona.length > 0 ? `${persona}\n\n${CHAT_BEHAVIOR}` : CHAT_BEHAVIOR
}

/**
 * 文案生成器：让模型按素材现写人话，而不是套模板。
 *
 * 为什么单独一个模块：卡片上的文字是给人读的，模板拼出来的句子
 * （「本次没有额外的结论要点」这类）一眼就是机器。这里改为把
 * 素材交给 `ctx.llm` 流式生成一段自然表述。
 *
 * 约束：
 *  - 走 dsh 的 `ctx.llm` 服务，不自己接 provider、不碰密钥。
 *  - **失败必须静默降级**到调用方给的兜底文案：文案是锦上添花，
 *    绝不能因为它失败就让汇报或提问发不出去。
 *  - 有超时上限；流式读取 `text-delta` 直到 `finish`。
 *  - 只写「给飞书看的话」：人设（config.persona）在这里注入，网页会话
 *    里 dsh 自己的说话方式不受影响。
 */
import type { Logger } from './types.ts'

/** ctx.llm 的最小结构面（只声明用到的部分，避免耦合整个类型）。 */
export interface LlmLike {
  stream: (options: {
    provider: string
    model: string
    messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>
    maxTokens?: number
    temperature?: number
  }) => AsyncIterable<{ type?: string; text?: string; reason?: unknown }>
}

/** 从任意 ctx 里软取 llm 服务；缺失或形状不对时返回 undefined。 */
export function llmFrom(ctx: { get: (name: string) => unknown }): LlmLike | undefined {
  const service = ctx.get('llm')
  if (typeof service !== 'object' || service === null) return undefined
  return typeof (service as LlmLike).stream === 'function' ? service as LlmLike : undefined
}

export interface WriterDeps {
  llm: () => LlmLike | undefined
  logger: Logger
  /** 默认路由（配置项）；为空时由调用方给具体 provider/model。 */
  defaultProvider: () => string
  defaultModel: () => string
  enabled: () => boolean
  /** 飞书侧人设；返回空串表示不加口吻设定。 */
  persona: () => string
  timeoutMs?: number
}

/** 会话里拿到的模型路由，优先于配置默认值。 */
export interface Route {
  provider?: string
  model?: string
}

export class Writer {
  private readonly deps: WriterDeps

  constructor(deps: WriterDeps) {
    this.deps = deps
  }

  /**
   * 把素材写成一段自然文案。
   * @param instruction 想要的口吻与结构（一句话即可）。
   * @param material 事实素材，模型只能基于它写。
   * @param fallback 生成失败时的兜底文案。
   * @param route 首选模型路由；缺省回落到配置。
   */
  async compose(instruction: string, material: string, fallback: string, route: Route = {}): Promise<string> {
    if (!this.deps.enabled()) return fallback
    const llm = this.deps.llm()
    if (llm === undefined) return fallback
    const provider = route.provider ?? this.deps.defaultProvider()
    const model = route.model ?? this.deps.defaultModel()
    if (provider.length === 0 || model.length === 0) return fallback

    // 人设只约束口吻：单独一行压在指令前面，并明确它不动事实结论。
    const persona = this.deps.persona().trim()
    const framed = persona.length === 0
      ? instruction
      : `${persona}\n（以上只约束说话口吻，不改变事实、结论与数字）\n\n${instruction}`

    const timeoutMs = this.deps.timeoutMs ?? 30000
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)
    const seen = new Map<string, number>()
    try {
      let text = ''
      const stream = llm.stream({
        provider,
        model,
        messages: [{
          role: 'user',
          content: [{
            type: 'text',
            text: `${framed}\n\n以下是事实素材，只能基于它写，不要编造未提及的内容：\n\n${material}`,
          }],
        }],
        // 给推理留足余量：deepseek-flash 会先花一批 token 思考（reasoning-delta），
        // 上限设小了会出现「思考吃满、正文还没开始」的空回复。
        maxTokens: 3000,
        temperature: 0.6,
      })
      for await (const chunk of stream) {
        if (controller.signal.aborted) break
        const kind = typeof chunk.type === 'string' ? chunk.type : 'unknown'
        seen.set(kind, (seen.get(kind) ?? 0) + 1)
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (chunk.type === 'finish') break
      }
      const cleaned = text.trim()
      if (cleaned.length === 0) {
        // 空回复是「汇报只剩兜底句」的元凶，这里必须把路由和收到的东西都记下来。
        const received = [...seen.entries()].map(([name, count]) => `${name}×${count}`).join(', ')
        this.deps.logger.warn(
          `[feishu-bridge] 文案生成返回空内容（${provider}/${model}；收到 ${received.length > 0 ? received : '零个 chunk'}），使用兜底文案`,
        )
        return fallback
      }
      return cleaned
    } catch (error) {
      this.deps.logger.warn(`[feishu-bridge] 文案生成失败，使用兜底文案：${String(error)}`)
      return fallback
    } finally {
      clearTimeout(timer)
    }
  }
}

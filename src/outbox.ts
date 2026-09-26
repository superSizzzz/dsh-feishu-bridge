/**
 * 出站通道：节流、幂等、就地更新。
 *
 * 设计取舍：
 *  - 同一会话在节流窗口内再次推送时，优先**就地更新上一条卡片**
 *    （`im messages patch`，14 天窗口 / 30KB 上限），而不是刷一条新的。
 *    这样「阶段结论 + 本轮改动」这类连续性信息不会把会话刷爆。
 *  - 窗口外或没有可更新卡片时，才新发一条。
 *  - 幂等键由会话 + 类型 + 内容哈希派生，重试不会重复推送。
 *
 * 投递目标用回调取而不是构造时快照：registry 加载完状态后目标才会确定，
 * 而 Outbox 在装配期就建好了。
 */
import { createHash } from 'node:crypto'
import { patchCard, sendCard, sendText } from './lark-cli.ts'
import type { CliOptions, Target } from './lark-cli.ts'
import type { Logger } from './types.ts'

export interface SendOutcome {
  messageId?: string
  /** 本轮是复用更新还是新发。 */
  mode: 'created' | 'updated' | 'suppressed' | 'failed'
}

export class Outbox {
  private readonly cli: CliOptions
  private readonly targetOf: () => Target
  private readonly logger: Logger
  private readonly throttleMs: number

  constructor(cli: CliOptions, targetOf: () => Target, logger: Logger, throttleMs: number) {
    this.cli = cli
    this.targetOf = targetOf
    this.logger = logger
    this.throttleMs = throttleMs
  }

  private key(sessionKey: string, kind: string, body: string): string {
    return createHash('sha1').update(`${sessionKey}|${kind}|${body}`).digest('hex').slice(0, 40)
  }

  /**
   * 推一张卡片。
   * @param sessionKey 会话标识，用于节流与幂等。
   * @param kind 推送类型，参与幂等键。
   * @param cardJson 卡片 JSON。
   * @param state 该会话上一张卡片的信息，用于节流窗口内就地更新。
   */
  async push(
    sessionKey: string,
    kind: string,
    cardJson: string,
    state: { lastMessageId?: string; lastMessageAt?: number },
    options: { force?: boolean } = {},
  ): Promise<SendOutcome> {
    const now = Date.now()
    const withinWindow = state.lastMessageAt !== undefined && now - state.lastMessageAt < this.throttleMs
    const canUpdate = withinWindow && state.lastMessageId !== undefined

    if (canUpdate && options.force !== true) {
      const ok = await patchCard(this.cli, state.lastMessageId as string, cardJson)
      if (ok) return { messageId: state.lastMessageId, mode: 'updated' }
      // 更新失败（超过 14 天 / 卡片被撤回 / 权限不足）：退回新发一条。
      this.logger.warn(`[feishu-bridge] 卡片更新失败，改为新发一条 (${kind})`)
    } else if (withinWindow && options.force !== true) {
      return { mode: 'suppressed' }
    }

    const messageId = await sendCard(this.cli, this.targetOf(), cardJson, this.key(sessionKey, kind, cardJson))
    if (messageId === undefined) {
      this.logger.warn(`[feishu-bridge] 推送失败 (${kind})`)
      return { mode: 'failed' }
    }
    return { messageId, mode: 'created' }
  }

  /** 不参与节流的即时回执（入站确认、指令回复、错误提示）。 */
  async reply(cardJson: string): Promise<string | undefined> {
    return sendCard(this.cli, this.targetOf(), cardJson)
  }

  /** 更新指定卡片（提问卡作废、答案已命中时用）。 */
  async update(messageId: string, cardJson: string): Promise<boolean> {
    return patchCard(this.cli, messageId, cardJson)
  }

  /** 发一条纯文本。闲聊用它 —— 聊天就该像聊天，不该每条都是卡片。 */
  async say(text: string): Promise<string | undefined> {
    return sendText(this.cli, this.targetOf(), text)
  }
}

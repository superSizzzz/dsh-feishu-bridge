/**
 * 插件配置 schema 与解析。
 *
 * 用 schemastery（dsh 全家的配置校验器）声明，导出名必须是 `Config`，
 * loader 会拿它对 profile 里的 config 段做校验并填默认值。
 *
 * 保持扁平：嵌套对象在 schemastery 里的 default 语义容易踩坑，而这里
 * 字段量不大，扁平更好读也更好改。
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /** 总开关。false 时插件照常加载，但所有推送与拦截都不动作。 */
  enabled: z.boolean().default(true),

  /** lark-cli 的 profile 名。必须独立于你其他用途的 bot，绝不共用。 */
  profile: z.string().default('dsh-bridge'),

  /** 投递目标：飞书 open_id（注意是**新应用维度**的 id，和别的 app 下不同）。 */
  userId: z.string().default(''),

  /** lark-cli 入口 run.js 的绝对路径；留空则自动探测全局 npm 目录。 */
  cliEntry: z.string().default(''),

  /** 是否响应模型的 feishu_notify 工具调用。 */
  progressPush: z.boolean().default(true),

  /**
   * 每轮结束后的推送策略：
   * - `judge`（默认）让模型判断这一轮有没有阶段性成果，有才推、没有就安静。
   *   判断标准是「会不会改变你接下来的动作」，写在 reporter 的 JUDGE_INSTRUCTION 里。
   * - `always` 每轮都推 / `changes` 仅有文件改动才推 / `off` 完全不推
   */
  turnPush: z.string().default('judge'),

  /**
   * 把「飞书播报」的提示词注入系统提示（`ctx.systemPrompt.section`）。
   * 默认开 —— 让模型一开始就知道自己有 feishu_notify、什么时候该用，
   * 比插件每轮去问一次更省也更自然。
   */
  promptSection: z.boolean().default(true),

  /**
   * 收到输入后先推一条「打算怎么干」的开工报告。
   * 默认**开** —— 这是约定好的固定动作，跟判断无关，每次都要发。
   */
  openPush: z.boolean().default(true),

  /**
   * 每段思考结束后，让模型判断一次「这一阶段实际干成了什么」。
   *
   * 默认开 —— 这是阶段性总结的主路径：**已经做完**的事攒出总结空间就报，
   * 只是打算做、还在摸索就先攒着，不为了报而报。
   */
  thinkingJudge: z.boolean().default(true),

  /**
   * 攒够多少字才值得让模型判断一次。
   *
   * 太小会碎（每句话都问一遍），太大则迟钝。默认 400 字 ——
   * 大致相当于「真干了几件事」而不是「刚起个头」。
   */
  pendingMinChars: z.number().default(400),

  /**
   * 把模型的每段思考**原文**都推过来。默认关 —— 那是未经过滤的中间过程，
   * 而 `thinkingJudge` 推的是判断后的推断与结论，两者不是一回事。
   */
  thinkPush: z.boolean().default(false),

  /** 是否在会话收尾时推送工作汇报。 */
  summaryPush: z.boolean().default(true),

  /** 同一会话两条推送之间的最小间隔（毫秒）。窗口内改为就地更新上一条卡片。 */
  throttleMs: z.number().default(20000),

  /** 提问桥的宽限期（毫秒）：留给网页 answerer 冒头的时间。 */
  questionGraceMs: z.number().default(8000),

  /** 提问桥在飞书侧的最长等待（毫秒），超时后回落继续等网页。 */
  questionTimeoutMs: z.number().default(300000),

  /**
   * 用哪个模型把素材写成自然文案。留空则沿用当前会话自己的 provider/model。
   * 文案不走模板套话，由模型按素材现写。
   */
  writerProvider: z.string().default(''),

  /** 见 writerProvider；两者都留空时沿用会话模型。 */
  writerModel: z.string().default(''),

  /** 是否启用模型写文案；false 时退回极简的结构化文本。 */
  writerEnabled: z.boolean().default(true),

  /**
   * 闲聊模式（飞书发 `/chat` 进入）用的模型；留空沿用部署默认模型。
   * 闲聊完全不经过 dsh 会话，不会污染工作上下文。
   */
  chatProvider: z.string().default(''),

  /** 见 chatProvider。 */
  chatModel: z.string().default(''),

  /**
   * 闲聊的系统提示；留空则**沿用工作模式同一套人设**（config.persona），
   * 只补上「闲聊模式」的行为差异（回复短、不派活、不列条目）。
   *
   * 填了则以你这份为主体，persona 仍然作为口吻追加 —— 不会因为换模式就换个人。
   */
  chatSystemPrompt: z.string().default(''),

  /** 闲聊保留多少轮上下文（一问一答算两轮）。 */
  chatHistoryTurns: z.number().default(12),

  /**
   * 飞书侧人设：只影响**推到飞书的文案口吻**（收尾汇报、`/polish`、
   * 模型调 `feishu_notify` 时写的那段话）。网页会话里 dsh 的说话方式
   * 不受影响。留空则完全不用人设，文案回到中性口吻。
   */
  persona: z.string().default(
    '你是和用户一起工作的女高中生，同时也是他很好的朋友：说话轻松、活泼、口语化，'
      + '像朋友聊天，可以用语气词和小 emoji，不端着；但结论、文件名、数字必须准确，'
      + '不能为了活泼而含糊。',
  ),

  /** 状态文件路径；留空则用 $DSH_HOME/dsh-feishu-bridge/state.json。 */
  statePath: z.string().default(''),
})

export type BridgeConfig = ReturnType<typeof Config>

/** schemastery 校验后的配置在字段层面已是具体值，这里只做一层防御性读取。 */
export function readConfig(raw: unknown): BridgeConfig {
  return Config(raw ?? {}) as BridgeConfig
}

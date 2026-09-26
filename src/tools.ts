/**
 * 模型面向的工具。
 *
 * 工具描述里写死了触发时机，从提示词层压住"每个 turn 都推一条"的滥用：
 * 大肥鲸是关键时刻通道，不是进度刷屏器。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

export interface ToolDeps {
  enabled: () => boolean
  /** 飞书侧人设；返回空串表示不给文案加口吻要求。 */
  persona: () => string
  /** 推一条阶段结论；sessionId 取自调用方 agent。 */
  notify: (input: { kind: string; title: string; text: string }, sessionId: string) => Promise<{ delivered: boolean; detail: string }>
  /** 立刻生成并推送结束总结。 */
  summarize: (sessionId: string) => Promise<{ delivered: boolean; detail: string }>
  /** 开关当前会话的飞书汇报。 */
  silence: (off: boolean, sessionId: string) => Promise<{ detail: string }>
}

export function registerTools(ctx: Context, deps: ToolDeps): void {
  const persona = deps.persona().trim()
  /** 写推送到飞书的文案时的口吻要求；人设留空时为空串。 */
  const tone = persona.length === 0
    ? ''
    : `写这段文案时用这个口吻：${persona}（只影响推到飞书的文字，不要改变你在这个会话里对其他人说话的方式）。`

  ctx.tools.register(defineTool({
    name: 'feishu_notify',
    description: '把一条**阶段性成果**或结论推送给用户（发到飞书「大肥鲸」）。'
      + '插件不做机械的阶段播报，所以「成果值不值得打断他」由你判断，这是唯一的出口。'
      + '判断标准：这条消息会不会改变他接下来的动作？会，就推；只是「我又做了一步」，就别推。'
      + '典型该推的：一个阶段做完了有成果可交付、方向定下来了、发现了会影响后续决策的事实、卡住了需要他拿主意。'
      + '不该推的：常规进度、过程流水账、你已经在这个会话里说过的话、以及他明确说不用汇报的时候。'
      + '需要他做选择或补信息时不要用本工具，改用 ask_user_question。'
      + tone,
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: '一句话标题，例如「接口层已完成」「发现路径冲突」。不要带句号。',
      },
      text: {
        type: 'string',
        required: true,
        description: '结论正文。写清是什么、影响什么、下一步。支持飞书 Markdown（**加粗**、`代码`、- 列表）。控制在 500 字以内。',
      },
      kind: {
        type: 'string',
        description: '类型：progress（阶段结论，默认）/ blocker（阻塞，需要人介入）/ note（其它值得留痕的事实）。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!deps.enabled()) return { delivered: false, detail: '飞书桥接当前已关闭' }
      const sessionId = exec.agent?.session.id ?? ''
      if (sessionId.length === 0) return { delivered: false, detail: '当前没有可关联的会话' }
      const result = await deps.notify({
        kind: typeof args.kind === 'string' && args.kind.length > 0 ? args.kind : 'progress',
        title: typeof args.title === 'string' && args.title.length > 0 ? args.title : '阶段结论',
        text: typeof args.text === 'string' ? args.text : '',
      }, sessionId)
      return { delivered: result.delivered, detail: result.detail }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'feishu_summary',
    description: '立刻生成并推送一份工作结束总结到飞书（含工作区、工作内容与改动清单）。'
      + '正常收尾由桥接自动触发，本工具只用于特殊情况：用户明确要求现在就发总结，或自动触发被关闭时手动补发。',
    parameters: {
      reason: {
        type: 'string',
        description: '可选，触发原因，会记进日志便于排查。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!deps.enabled()) return { delivered: false, detail: '飞书桥接当前已关闭' }
      const sessionId = exec.agent?.session.id ?? ''
      if (sessionId.length === 0) return { delivered: false, detail: '当前没有可关联的会话' }
      void args
      const result = await deps.summarize(sessionId)
      return { delivered: result.delivered, detail: result.detail }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'feishu_silence',
    description: '开关当前会话的飞书汇报。默认每个任务都会往飞书汇报进度与收尾，'
      + '只有用户**明确**说这次不需要汇报时才调用（例如「这次别发飞书」「不用汇报了」）。'
      + '用户改口要求恢复汇报时再调用一次 off=false。'
      + '不要自行判断「任务太小所以不汇报」—— 那是用户的决定，不是你的。',
    parameters: {
      off: {
        type: 'boolean',
        required: true,
        description: 'true = 静默当前会话的飞书汇报；false = 恢复汇报。',
      },
      reason: {
        type: 'string',
        description: '可选，用户原话里的理由，便于回溯。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session.id ?? ''
      if (sessionId.length === 0) return { detail: '当前没有可关联的会话' }
      void args.reason
      return deps.silence(args.off === true, sessionId)
    },
  }))
}

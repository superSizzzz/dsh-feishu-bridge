/**
 * 卡片渲染。
 *
 * 全部按官方 lark-im skill 的 Card 2.0 工作流构造，并逐条对齐 P0–P7：
 *  - P1 层级：header 承载「这是什么」，body 内只有一个焦点块
 *  - P2 分组：同主题字段进同一个 column_set / 背景块，不一路 hr 平铺
 *  - P3 复杂度：2–5 个视觉块，主色系 ≤3
 *  - P7 健壮：并列列一律 weighted，不用 stretch（防移动端拉伸）
 *
 * 文案风格：飞书侧一律用「一起工作的女高中生 / 好朋友」的口吻（config.persona
 * 只管模型现写的那几段，这里的固定文案是按同一人设写死的）。
 * 标题用内容主题，不挂机器人署名前缀；标题为空时才省略 header。
 */
import type { QuestionItem } from './types.ts'

/** 只在「上线」这类需要自报家门的场合使用。 */
export const BOT_SIGN = '大肥鲸'

interface PlainText {
  tag: 'plain_text'
  content: string
}

function plain(content: string): PlainText {
  return { tag: 'plain_text', content }
}

function markdown(content: string): Record<string, unknown> {
  return { tag: 'markdown', content }
}

/** 一行若干「标签 + 值」的字段块，带底色。用于工作区/会话/时间这类元信息。 */
function fieldRow(pairs: Array<[string, string]>, background: string): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: 'medium',
    columns: pairs.map(([label, value]) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      background_style: background,
      padding: '8px',
      elements: [markdown(`**${label}**\n${value}`)],
    })),
  }
}

function cardOf(template: string, title: string, subtitle: string, elements: unknown[]): string {
  return JSON.stringify({
    schema: '2.0',
    config: { width_mode: 'default', update_multi: true },
    ...title.length === 0 ? {} : { header: { title: plain(title), subtitle: plain(subtitle), template } },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px', elements },
  })
}

/**
 * 会话标识：短码是路由用的稳定身份，标题是给人看的。
 * 两者都留着 —— 代号用于 `/use`，标题用于一眼认出这是哪件事。
 */
function sessionLabel(code: string, title?: string): string {
  const badge = `#${code}`
  return title === undefined || title.length === 0 ? badge : `${badge}　${title}`
}

/** 改动统计的紧凑渲染：`12 文件 +384 −96`。 */
export function changeStat(total: number, added: number, deleted: number): string {
  return `${total} 文件  +${added} −${deleted}`
}

/** 改动清单正文：每行 ``path  +a −d``，排序已在 dsh 侧完成。 */
export function changeList(files: Array<{ display: string; added: number; deleted: number }>, limit = 30): string {
  const shown = files.slice(0, limit)
  const lines = shown.map((f) => `\`${f.display}\`  +${f.added} −${f.deleted}`)
  if (files.length > shown.length) lines.push(`… 还有 ${files.length - shown.length} 个文件没列出来`)
  return lines.join('\n')
}

/** 阶段结论卡：标题用调用方给的主题句。 */
export function progressCard(input: {
  title: string
  body: string
  cwd: string
  code: string
  /** 会话标题：dsh 标题服务给的，或首条用户消息截的兜底。 */
  sessionTitle?: string
  turn?: number
  at: string
  changes?: { total: number; added: number; deleted: number; files: Array<{ display: string; added: number; deleted: number }> }
}): string {
  const meta: Array<[string, string]> = [
    ['在哪干活', input.cwd],
    ['会话', `${sessionLabel(input.code, input.sessionTitle)}${input.turn === undefined ? '' : ` · turn ${input.turn}`}`],
  ]
  const elements: unknown[] = [fieldRow(meta, 'blue-50'), markdown(input.body)]
  if (input.changes !== undefined && input.changes.total > 0) {
    elements.push(markdown(`**这轮动了**　${changeStat(input.changes.total, input.changes.added, input.changes.deleted)}\n${changeList(input.changes.files, 8)}`))
  }
  elements.push(markdown(`<font color='grey'>有啥要补的直接回我一句就行 · ${input.at}</font>`))
  return cardOf('blue', input.title, '大肥鲸来报', elements)
}

/**
 * 需要你做决定的提问卡。
 *
 * 第一版刻意不做卡片按钮：按钮要额外消费 `card.action.trigger` 事件流，
 * 而文本作答（含回编号）已经覆盖全部语义。选项以编号列表呈现。
 */
export function questionCard(input: {
  questions: QuestionItem[]
  cwd: string
  code: string
  /** 会话标题：dsh 标题服务给的，或首条用户消息截的兜底。 */
  sessionTitle?: string
  at: string
  minutes: number
}): string {
  const elements: unknown[] = [fieldRow([['在哪干活', input.cwd], ['会话', sessionLabel(input.code, input.sessionTitle)]], 'yellow-50')]
  const multi = input.questions.length > 1
  input.questions.forEach((q, index) => {
    const head = q.header === undefined ? '' : `**${q.header}**\n`
    const prefix = multi ? `**${index + 1}.** ` : ''
    elements.push(markdown(`${prefix}${head}${q.question}`))
    const options = q.options ?? []
    if (options.length > 0) {
      const listed = options.map((o, i) => {
        const desc = o.description === undefined ? '' : `　—　${o.description}`
        return `\`${i + 1}\`　${o.label}${desc}`
      })
      elements.push(markdown(listed.join('\n')))
      // 有选项就配按钮：点一下即作答。回调走 card.action.trigger 事件流，
      // value 里只带 qid + label，匹配由桥接侧的待答票据完成。
      elements.push({
        tag: 'column_set',
        flex_mode: 'flow',
        horizontal_spacing: 'small',
        columns: options.slice(0, 6).map((option, index) => ({
          tag: 'column',
          width: 'auto',
          elements: [{
            tag: 'button',
            text: plain(option.label.slice(0, 28)),
            type: index === 0 ? 'primary' : 'default',
            behaviors: [{ type: 'callback', value: { bridge: { qid: q.id, label: option.label } } }],
          }],
        })),
      })
    }
  })
  const hint = multi
    ? '点按钮就行；也可以一题一题回我，比如 `1` 或 `1 用飞书通道`'
    : '点按钮，或者直接回我文字（只回编号也认）'
  elements.push(markdown(`<font color='grey'>${hint} · ${input.minutes} 分钟内回我都算数 · ${input.at}</font>`))
  return cardOf('yellow', '想听听你的主意', '先问网页那边，没人答我再来问你', elements)
}

/**
 * 工作汇报卡：自然文案 + 结构化事实。
 *
 * 「工作内容」一段刻意交给模型现写（`narrative`），不走 bullet 模板 ——
 * 模板拼出来的句子一眼是机器。改动清单这类事实仍用结构化呈现，
 * 因为它要的是准确而不是文采。
 */
export function summaryCard(input: {
  title: string
  narrative: string
  cwd: string
  code: string
  /** 会话标题：dsh 标题服务给的，或首条用户消息截的兜底。 */
  sessionTitle?: string
  startedAt: string
  endedAt: string
  turns: number
  toolCalls: number
  changes?: { total: number; added: number; deleted: number; files: Array<{ display: string; added: number; deleted: number }> }
}): string {
  const meta: Array<[string, string]> = [
    ['在哪干活', input.cwd],
    ['会话', sessionLabel(input.code, input.sessionTitle)],
    ['过程', `${input.startedAt} → ${input.endedAt} · ${input.turns} turn · ${input.toolCalls} 次工具调用`],
  ]
  const elements: unknown[] = [fieldRow(meta, 'green-50'), markdown(input.narrative)]
  if (input.changes !== undefined && input.changes.total > 0) {
    elements.push(markdown(`**这轮动的文件（${changeStat(input.changes.total, input.changes.added, input.changes.deleted)}）**\n${changeList(input.changes.files)}`))
  }
  return cardOf('green', input.title, '大肥鲸汇报', elements)
}

/** 通用回执卡：标题直接用传入的主题（帮助文档 / 会话状态 / 已送达…）。 */
export function noticeCard(text: string, title = '', template = 'grey'): string {
  return cardOf(template, title, '大肥鲸回话', [markdown(text)])
}

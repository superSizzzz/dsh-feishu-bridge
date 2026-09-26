/**
 * dsh-feishu-bridge —— 大肥鲸飞书桥。
 *
 * 三条链路：
 *   出站  dsh 事件 / 模型工具 → 卡片 → 飞书
 *   入站  飞书消息 → 指令 / 提问作答 / 会话 followup
 *   提问  网页优先，无人应答才走飞书（questions.ts）
 *
 * 加载方式（本地 checkout，热重载）：
 *   ~/.dsh/profiles/web/cordis.patch.yml 里 insert
 *   `file:///D:/coding/AgentSkills/dsh-feishu-bridge/src/index.ts`
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Config, readConfig } from './config.ts'
import type { ConfigPageState } from './config-page.ts'
import { readBody, renderConfigPage, sendHtml } from './config-page.ts'
import { botInfo, downloadResource, messageGet, resolveCliEntry, whoami } from './lark-cli.ts'
import type { CliOptions, Target } from './lark-cli.ts'
import { Registry } from './registry.ts'
import { Outbox } from './outbox.ts'
import { Inbox } from './inbox.ts'
import { QuestionBridge } from './questions.ts'
import { Reporter } from './reporter.ts'
import { Writer, llmFrom } from './writer.ts'
import { ChatEngine, type ChatStore } from './chat.ts'
import { registerTools } from './tools.ts'
import { noticeCard, progressCard } from './render.ts'
import type { ChangeSet, Logger } from './types.ts'

/**
 * 桥接自己声明的消息来源 kind。harness 的 `MessageSourceMap` 是合并可
 * 扩展的（每个生产者声明自己的 kind），插件注入的消息必须能被看成
 * 「不是用户手打的那一类」，所以这里注册一个专有 kind。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'feishu-bridge': { kind: 'feishu-bridge'; origin: 'polish' }
  }
}

export const name = 'feishu-bridge'
/** 只硬依赖工具注册表；其余服务（agents / workspaceChanges）用 ctx.get 软取，缺了也不致命。 */
export const inject = ['tools']
export { Config }

interface AgentLike {
  session: { id: string; header?: { cwd?: string } }
  /**
   * 必须传完整的 UserMessage（`createUserMessage()` 产出）：缺 `id`/`role`
   * 的对象在运行时能被收下，但会在会话下次加载时被 harness 判为损坏，
   * 永久卡住这个会话。历史上这里就是踩了这个坑。
   */
  followup: (message: UserMessage) => void
  cancel: (cause: { kind: string }) => void
  status?: string
}

interface AgentRegistryLike {
  get: (id: string) => AgentLike | undefined
  list?: () => AgentLike[]
}

const HELP = [
  '**我能帮你做这些**',
  '- `/stop`　把当前会话正在跑的这一轮叫停',
  '- `/status`　看看现在接着哪个会话、在哪儿干活',
  '- `/list`　把我记过的会话列出来',
  '- `/use <短码>`　换个默认投递目标',
  '- `/polish`　让 dsh 用模型重写一版更好读的总结',
  '- `/mute`　这一段先别往飞书说（静默自动推送）',
  '- `/unmute`　想继续听我汇报就喊我一声',
  '- `/chat`　切到闲聊模式（消息不进 dsh，就单纯聊天）',
  '- `/work`　切回工作模式',
  '- `/mode`　看看现在是什么模式',
  '- `/forget`　把闲聊记录抹掉',
  '- `/help`　就是这条啦',
  '',
  '**不用打指令**：工作模式下直接发文字 = 说给当前会话听；跳出提问卡时，直接回我就是作答（回编号也认）。',
].join('\n')

/**
 * 让模型自己产出润色版总结并推回飞书，无需桥接侧再造一套模型调用。
 * @param persona 飞书侧人设；留空则不加口吻要求。
 */
function polishPrompt(persona: string): string {
  return [
    '【飞书桥接】请为刚才这一段工作写一份更好读的收尾总结，然后用 feishu_notify 工具发给用户。',
    persona.length === 0
      ? ''
      : `口吻：这条总结是发到飞书的，请用这个口吻写——${persona}（只影响这一条发给飞书的文案，不用改变你在会话里的说话方式）。`,
    '要求：',
    '1. 用 3–6 条要点说清「做了什么、结论是什么、还有什么没做」，不要复述过程流水账；',
    '2. 明确列出改动过的文件与文件数量（若这一轮有改动）；',
    '3. 正文用飞书 Markdown（**加粗**、`代码`、- 列表），控制在 500 字内；',
    '4. 只调用一次 feishu_notify，不要重复推送。',
  ].filter((line) => line.length > 0).join('\n')
}

/**
 * 注入系统提示的「飞书播报」约定。
 *
 * 为什么走系统提示而不是只写在工具描述里：会话一开模型就知道规则，
 * 不用等到需要用时才发现有这个工具。插件自己只负责开工与收尾两件
 * 固定动作，中间那些值得打断他的成果由模型判断。
 */
const FEISHU_PROMPT_SECTION = [
  '## 飞书播报',
  '',
  '用户通过飞书上的「{{feishu_bot_name}}」跟你协作，你有 `feishu_notify` 工具可以推消息给他。',
  '',
  '**判断标准**：这条消息会不会改变他接下来的动作？会，就推；只是「我又做了一步」，就别推。',
  '',
  '**该推的时刻**：',
  '- 一个阶段做完、有成果可交付（主要用途）',
  '- 发现了会影响后续决策的关键事实',
  '- 卡住了、需要他拿主意（若需要他做选择，改用 ask_user_question）',
  '',
  '**不要推**：常规进度、过程流水账、你已经在这个会话里说过的话；他说过不用汇报时就安静。',
  '',
  `开工报告与收尾的工作汇报由插件自动负责，你不用操心，只管中间那些值得打断他的成果。`,
].join('\n')

/** 工作汇报正文的写作要求：要具体、要有内容，不要写成一句敷衍。 */
const NARRATIVE_INSTRUCTION = [
  '根据下面的素材，用中文写一份**具体**的收尾工作汇报。',
  '要求：',
  '- 说清三件事：这一趟具体做了什么（动作和对象都要落地）、得出的结论是什么、还有什么没做完或不放心；',
  '- 具体优先：能说「修好了飞书图片下载链路、把三个 bug 逐个定位」就别只说「做了些修改」；',
  '- 素材里没有的不要编；不确定的地方就直说不确定；',
  '- 可以用 `- ` 分点把不同的事分开，但不要写成公文腔，不要「本次」「综上」「现将」这类词；',
  '- 不要罗列文件清单（卡片下方已经单列了）。',
].join('\n')

/** 上线问候的写作要求：要有创意，不要系统播报腔。 */
const GREETING_INSTRUCTION = [
  '你刚被启动，要向用户报个到。写一句话（最多两句）的问候。',
  '要求：',
  '- 要有点创意和个性，别用「已启动」「已上线」「准备就绪」「服务正常」这类系统播报腔；',
  '- 可以自然地带出时间感、隔了多久又见面，或者想到什么说什么；',
  '- 现在还没接到活，所以别承诺要做什么，就是打个招呼；',
  '- 不要每次都同一个句式。',
].join('\n')

/** 给问候一点随机角度，避免每次重启都是同一套说辞。 */
const GREETING_ANGLES = [
  '结合现在的时间点说话（深夜、清早、饭点都可以）。',
  '结合「隔了多久又见面」这件事说话。',
  '带一点刚睡醒或刚喝完咖啡的精神头，轻松点。',
  '用一句俏皮话开场，但别油腻。',
  '就当老朋友随口招呼一声，不用太用力。',
]

/** 把毫秒差说成人话。 */
function humanGap(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

/** 飞书把图片资源键渲染进文本，形如 `[Image: img_v3_xxx]`。 */
const IMAGE_KEY_PATTERN = /img_v3_[A-Za-z0-9_-]+/

/**
 * 从消息体里挖出图片资源键。
 *
 * 实测飞书的 `content` 并不是原始 JSON，而是一句渲染好的文本
 * （`"[Image: img_v3_0215s_...]"`），所以既要在字段里找，
 * 也要在字符串里正则捞 —— 两路都留着，结构变了也还能用。
 */
function findImageKey(value: unknown, depth = 0): string | undefined {
  if (depth > 6) return undefined
  if (typeof value === 'string') return IMAGE_KEY_PATTERN.exec(value)?.[0]
  if (value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageKey(item, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const record = value as Record<string, unknown>
  for (const key of ['image_key', 'file_key']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.length > 0) {
      const matched = IMAGE_KEY_PATTERN.exec(candidate)
      return matched === null ? candidate : matched[0]
    }
  }
  for (const [key, nested] of Object.entries(record)) {
    if (key === 'content' && typeof nested === 'string') {
      const matched = IMAGE_KEY_PATTERN.exec(nested)
      if (matched !== null) return matched[0]
      try {
        const found = findImageKey(JSON.parse(nested), depth + 1)
        if (found !== undefined) return found
      } catch {
        // content 不是 JSON 就跳过。
      }
      continue
    }
    const found = findImageKey(nested, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 按文件头判断图片格式。
 *
 * 不能靠扩展名：下载时我们只能给一个名字，而附件服务会拿声明的 mediaType
 * 跟真实字节校验，猜错了整张图会被拒。
 */
function sniffMediaType(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString('ascii')
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return 'image/png'
}

/** 插件自己的状态目录。 */
const STATE_DIR = process.env.DSH_HOME === undefined
  ? join(homedir(), '.dsh', 'dsh-feishu-bridge')
  : join(process.env.DSH_HOME, 'dsh-feishu-bridge')

/**
 * 启动探针：把关键节点写进 `$DSH_HOME/dsh-feishu-bridge/boot.log`。
 * dsh 热重载时的报错只进宿主控制台，插件侧需要一个落盘的自证痕迹，
 * 否则"插件到底加载了没有"只能靠猜。探针本身绝不能影响插件运行。
 */
function probe(message: string): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(join(STATE_DIR, 'boot.log'), `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // 探针失败不影响插件。
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 入站选举：飞书同一条消息只该被一个 dsh 实例消费。
 *
 * 插件默认全局挂载，同一台机器上可能同时跑着 web 与 headless 两个 profile；
 * 用 pid 锁选出唯一消费者，抢不到锁的实例照常做本地会话的播报与汇报，
 * 只是不读飞书消息 —— 否则同一条飞书消息会被处理两次，回执也是双份。
 */
function acquireInboxLock(lockPath: string, logger: Logger): boolean {
  try {
    const held = readFileSync(lockPath, 'utf8').trim()
    const pid = Number(held)
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && processAlive(pid)) return false
  } catch {
    // 没有锁文件或读不动：继续尝试抢占。
  }
  try {
    mkdirSync(dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, String(process.pid), 'utf8')
    return true
  } catch (error) {
    logger.warn(`[feishu-bridge] 入站锁写入失败，本实例不消费飞书消息：${String(error)}`)
    return false
  }
}

/** 只由持有者释放：别人的锁不能删。 */
function releaseInboxLock(lockPath: string): void {
  try {
    if (readFileSync(lockPath, 'utf8').trim() !== String(process.pid)) return
    rmSync(lockPath, { force: true })
  } catch {
    // 锁已不在，忽略。
  }
}

export function apply(ctx: Context, rawConfig: unknown): void {
  probe('apply() entered')
  const config = readConfig(rawConfig)
  probe(`config: profile=${config.profile} target=${config.userId} enabled=${String(config.enabled)}`)
  const logger: Logger = {
    info: (message: string) => { ctx.logger.info(message) },
    warn: (message: string) => { ctx.logger.warn(message) },
    error: (message: string) => { ctx.logger.error(message) },
  }

  const cli: CliOptions = {
    entry: resolveCliEntry(config.cliEntry),
    // profile 用 getter 而不是快照：用户可以在配置页换成别的飞书 bot，
    // 改完立刻对这个桥的每次调用生效，不必重启插件。
    get profile(): string {
      return registry.overrides().profile ?? config.profile
    },
    timeoutMs: 30000,
  }
  const registry = new Registry(Registry.defaultPath(config.statePath))
  /**
   * 飞书侧的口吻人设。设置页可以改，所以每次现读而不是留快照 ——
   * 改完立刻对后续每一句文案生效，不用重启。
   */
  const persona = (): string => registry.overrides().persona ?? config.persona
  let target: Target = { kind: 'user', id: config.userId }
  /**
   * 机器人在飞书里的显示名。启动时用 `bot/v3/info` 探测真名，
   * 探测失败就退回这个默认值 —— 名字只影响文案，不该阻塞启动。
   */
  let botName = '大肥鲸'
  /** 解析到的 app id，配置面板展示用。 */
  let resolvedAppId = ''
  /**
   * 当前是不是闲聊模式。
   * 刻意**不持久化**：重启后回到工作模式更安全，免得忘了切回来、
   * 把要干的活当闲聊聊掉。闲聊的历史倒是持久化的。
   */
  let chatMode = false
  let disposed = false

  const outbox = new Outbox(cli, () => target, logger, config.throttleMs)

  /** 取 dsh 官方的改动清单口径。 */
  const resolveChanges = (sessionId: string, seq: number): ChangeSet | undefined => {
    if (seq < 0) return undefined
    const service = ctx.get('workspaceChanges') as { summary?: (id: string, s: number) => unknown } | undefined
    if (service === undefined || typeof service.summary !== 'function') return undefined
    const raw = service.summary(sessionId, seq)
    if (typeof raw !== 'object' || raw === null) return undefined
    const summary = raw as { total?: unknown; added?: unknown; deleted?: unknown; files?: unknown }
    const files = Array.isArray(summary.files) ? summary.files as Array<Record<string, unknown>> : []
    return {
      total: typeof summary.total === 'number' ? summary.total : files.length,
      added: typeof summary.added === 'number' ? summary.added : 0,
      deleted: typeof summary.deleted === 'number' ? summary.deleted : 0,
      files: files.map((file) => ({
        path: typeof file.path === 'string' ? file.path : '',
        display: typeof file.display === 'string' ? file.display : String(file.path ?? ''),
        added: typeof file.added === 'number' ? file.added : 0,
        deleted: typeof file.deleted === 'number' ? file.deleted : 0,
      })),
    }
  }

  const pushProgress = async (sessionId: string, kind: string, card: string, force = false): Promise<{ messageId?: string }> => {
    if (isSilenced(sessionId)) return {}
    const binding = registry.get(sessionId)
    const outcome = await outbox.push(sessionId, kind, card, {
      ...binding?.lastMessageId === undefined ? {} : { lastMessageId: binding.lastMessageId },
      ...binding?.lastMessageAt === undefined ? {} : { lastMessageAt: binding.lastMessageAt },
    }, { force })
    if (outcome.messageId !== undefined) {
      registry.touch(sessionId, { lastMessageId: outcome.messageId, lastMessageAt: Date.now() })
      return { messageId: outcome.messageId }
    }
    return {}
  }

  /**
   * 启动阶段（还没有任何会话）能用的模型路由。
   * 优先取部署的默认模型选择，其次才是配置里的 writer 覆盖项。
   */
  const bootRoute = (): { provider?: string; model?: string } => {
    const service = ctx.get('agentDefaultModel') as { currentSelection?: () => { provider?: string; model?: string } } | undefined
    const selection = service?.currentSelection?.()
    if (selection?.provider !== undefined && selection.model !== undefined) {
      return { provider: selection.provider, model: selection.model }
    }
    return {
      ...config.writerProvider.length === 0 ? {} : { provider: config.writerProvider },
      ...config.writerModel.length === 0 ? {} : { model: config.writerModel },
    }
  }

  const writer = new Writer({
    llm: () => llmFrom(ctx),
    // 文案生成失败是「汇报只有兜底句」的典型原因，日志同时落进 boot.log 便于回查。
    logger: {
      info: (message: string) => { logger.info(message); probe(message) },
      warn: (message: string) => { logger.warn(message); probe(message) },
      error: (message: string) => { logger.error(message); probe(message) },
    },
    defaultProvider: () => bootRoute().provider ?? config.writerProvider,
    defaultModel: () => bootRoute().model ?? config.writerModel,
    enabled: () => config.enabled && config.writerEnabled,
    persona,
  })

  /**
   * 闲聊引擎。
   *
   * 它复用 dsh 的模型服务（凭据、provider 路由都不用插件操心），
   * 但**完全不碰会话** —— 没有 agent、没有 session、没有工具，
   * 聊过什么都不会进 dsh 的历史。历史自己存，重启也还在。
   */
  const chat = new ChatEngine({
    llm: () => llmFrom(ctx),
    logger,
    systemPrompt: () => config.chatSystemPrompt,
    route: () => {
      const fallback = bootRoute()
      const overrides = registry.overrides()
      const configuredProvider = overrides.chatProvider ?? config.chatProvider
      const configuredModel = overrides.chatModel ?? config.chatModel
      const provider = configuredProvider.length > 0 ? configuredProvider : fallback.provider
      const model = configuredModel.length > 0 ? configuredModel : fallback.model
      return {
        ...provider === undefined ? {} : { provider },
        ...model === undefined ? {} : { model },
      }
    },
    maxTurns: () => config.chatHistoryTurns,
    persona,
    onChange: () => { registry.setChatStore(chat.dump()) },
  })

  /**
   * 取会话自己的模型路由。
   *
   * 顺序上**部署默认模型优先**：它是用户在 GUI 里明确配置、并且已被上线问候
   * 验证可用的那条路；实测会话路由会拿到空回复，所以只作为补充。
   */
  const routeOf = (sessionId: string): { provider?: string; model?: string } => {
    const fallback = bootRoute()
    const agent = agents()?.get(sessionId) as { options?: { provider?: string; model?: string } } | undefined
    const options = agent?.options
    const provider = fallback.provider ?? options?.provider ?? config.writerProvider
    const model = fallback.model ?? options?.model ?? config.writerModel
    return {
      ...provider === undefined || provider.length === 0 ? {} : { provider },
      ...model === undefined || model.length === 0 ? {} : { model },
    }
  }

  /**
   * 被静默的会话：用户明确说过这一段不用汇报。
   * 插件默认全局开启汇报，这里是唯一的例外通道（飞书 `/mute` 或模型调 `feishu_silence`）。
   */
  const silenced = new Set<string>()
  const isSilenced = (sessionId: string): boolean => silenced.has(sessionId)

  const reporter = new Reporter({
    logger,
    enabled: () => config.enabled,
    turnPush: () => config.turnPush,
    openPush: () => config.openPush,
    thinkPush: () => config.thinkPush,
    thinkingJudge: () => config.thinkingJudge,
    pendingMinChars: () => config.pendingMinChars,
    summaryPush: () => config.summaryPush,
    quietMs: 90000,
    ensureBinding: (sessionId, cwd) => { registry.ensure(sessionId, cwd) },
    touchBinding: (sessionId, patch) => { registry.touch(sessionId, patch) },
    bindingOf: (sessionId) => registry.get(sessionId),
    markActive: (sessionId) => { registry.setActiveSession(sessionId) },
    // dsh 的标题服务按 session 对象读；没挂载时返回空串，由 reporter 用首条消息兜底。
    sessionTitle: (session) => {
      const service = ctx.get('sessionTitle') as { get?: (value: unknown) => { title?: unknown } | undefined } | undefined
      const snapshot = service?.get?.(session)
      return typeof snapshot?.title === 'string' ? snapshot.title : ''
    },
    resolveChanges,
    pushProgress,
    pushSummary: (sessionId, reason) => pushSummary(sessionId, reason),
    // 开工报告独立成卡，不参与节流合并，否则会被紧跟的阶段卡覆盖掉。
    pushOpen: async (sessionId, card) => {
      if (isSilenced(sessionId)) return {}
      const messageId = await outbox.reply(card)
      if (messageId === undefined) return {}
      registry.touch(sessionId, { lastMessageId: messageId, lastMessageAt: Date.now() })
      return { messageId }
    },
    // 思考卡同样独立发出：它记录的是过程，被合并掉就失去意义了。
    pushThink: async (sessionId, card) => {
      if (isSilenced(sessionId)) return {}
      const messageId = await outbox.reply(card)
      if (messageId === undefined) return {}
      registry.touch(sessionId, { lastMessageId: messageId, lastMessageAt: Date.now() })
      return { messageId }
    },
    // 进度卡的正文也交给模型现写，素材里带本轮用过的工具，才能说出「干了啥」。
    compose: (sessionId, instruction, material, fallback) =>
      writer.compose(instruction, material, fallback, routeOf(sessionId)),
  })

  const pushSummary = async (sessionId: string, reason: string): Promise<{ delivered: boolean; detail: string }> => {
    if (!config.enabled) return { delivered: false, detail: '飞书桥接已关闭' }
    if (!config.summaryPush) return { delivered: false, detail: '总结推送已关闭' }
    if (isSilenced(sessionId)) return { delivered: false, detail: '这个会话已被静默' }
    const binding = registry.get(sessionId)
    if (binding === undefined) return { delivered: false, detail: '没有这个会话的记录' }
    if (binding.turns > 0 && binding.turns <= binding.lastSummaryTurn) {
      return { delivered: false, detail: '这一轮已经推过总结了' }
    }
    const narrative = await writer.compose(
      NARRATIVE_INSTRUCTION,
      reporter.material(sessionId),
      '这一轮先到这儿～下面是要核对的事实和动过的文件。',
      routeOf(sessionId),
    )
    const built = reporter.buildSummary(sessionId, narrative)
    if (built === undefined) return { delivered: false, detail: '总结组装失败' }
    const outcome = await outbox.push(sessionId, `summary-${binding.turns}`, built.card, {
      ...binding.lastMessageId === undefined ? {} : { lastMessageId: binding.lastMessageId },
      ...binding.lastMessageAt === undefined ? {} : { lastMessageAt: binding.lastMessageAt },
    }, { force: true })
    if (outcome.messageId === undefined) return { delivered: false, detail: '推送失败，检查 lark-cli 状态' }
    registry.touch(sessionId, {
      lastSummaryTurn: binding.turns,
      lastMessageId: outcome.messageId,
      lastMessageAt: Date.now(),
    })
    logger.info(`[feishu-bridge] 已推送结束总结 (${reason})`)
    return { delivered: true, detail: '已推送' }
  }

  const agents = (): AgentRegistryLike | undefined => ctx.get('agents') as AgentRegistryLike | undefined

  const activeAgent = (): { sessionId: string; agent: AgentLike } | undefined => {
    const sessionId = registry.activeSessionId()
    if (sessionId === undefined) return undefined
    const agent = agents()?.get(sessionId)
    return agent === undefined ? undefined : { sessionId, agent }
  }

  const reply = async (text: string, title = ''): Promise<void> => {
    await outbox.reply(noticeCard(text, title))
  }

  /** 闲聊历史的键：私聊场景就是投递目标。 */
  const chatKey = (): string => (target.id.length > 0 ? target.id : 'default')

  /** 闲聊回复走纯文本 —— 聊天就该像聊天，不必每条都是卡片。 */
  const chatReply = async (text: string): Promise<void> => {
    try {
      const answer = await chat.reply(chatKey(), text)
      await outbox.say(answer)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      logger.warn(`[feishu-bridge] 闲聊失败: ${detail}`)
      await reply(`聊不动了：${detail}`, '闲聊出错')
    }
  }

  const deliver = async (text: string): Promise<void> => {
    const active = activeAgent()
    if (active === undefined) {
      await reply('现在还没有开着的 dsh 会话呀～先在 dsh 里开一个、或者跑一轮，我就自动接上啦。', '还没接上')
      return
    }
    active.agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    const binding = registry.get(active.sessionId)
    const cwd = binding?.cwd ?? ''
    await reply(`好，已经丢给 **#${binding?.code ?? '----'}** 啦 👇\n${cwd}`, '送到啦')
  }

  const runCommand = async (raw: string): Promise<void> => {
    const [command = '', ...rest] = raw.slice(1).trim().split(/\s+/)
    switch (command.toLowerCase()) {
      case 'help': {
        await reply(HELP, '我能做啥')
        return
      }
      case 'config': {
        const overrides = registry.overrides()
        const field = rest[0] ?? ''
        const value = rest.slice(1).join(' ')
        const editable = ['userId', 'chatProvider', 'chatModel', 'chatSystemPrompt']
        if (field.length === 0) {
          const route = bootRoute()
          await reply([
            `**绑定的人**　\`${target.id.length > 0 ? target.id : '（还没认领，发我一句话就自动记住）'}\``,
            `**lark-cli profile**　\`${config.profile}\``,
            `**闲聊模型**　${overrides.chatProvider ?? config.chatProvider ?? ''} / ${overrides.chatModel ?? config.chatModel ?? ''}`.trim(),
            `**默认模型**　${route.provider ?? '（没读到）'} / ${route.model ?? '（没读到）'}`,
            '',
            '改法：`/config chatModel deepseek-flash`',
            '恢复：`/config chatModel reset`',
            `能改的：${editable.map((k) => `\`${k}\``).join('、')}`,
            '',
            '**模型提供商和 API Key 请到 dsh 自己的设置页改** —— 那里管着所有 provider 的凭据，闲聊直接复用，不用在这里填一遍。',
          ].join('\n'), '配置')
          return
        }
        if (!editable.includes(field)) {
          await reply(`\`${field}\` 改不了。能改的：${editable.map((k) => `\`${k}\``).join('、')}`, '配置')
          return
        }
        if (value.length === 0 || value === 'reset') {
          if (field === 'userId') {
            // 解绑：下一个给 bot 发消息的人会被重新认领。
            target = { kind: 'user', id: '' }
            registry.setTarget('user', '')
            await reply('解除绑定了。下个给我发消息的人会被重新认领。', '配置')
            return
          }
          registry.setOverride(field, undefined)
          await reply(`\`${field}\` 恢复默认了。`, '配置')
          return
        }
        if (field === 'userId') {
          // 绑定目标存在 registry 里（它才是投递地址的权威），不走 overrides。
          target = { kind: 'user', id: value }
          registry.setTarget('user', value)
          await reply(`绑定的人改成 \`${value}\` 了。`, '配置')
          return
        }
        registry.setOverride(field, value)
        await reply(`\`${field}\` 设成 \`${value}\` 了。`, '配置')
        return
      }
      case 'chat': {
        chatMode = true
        const seen = chat.size(chatKey())
        await reply(
          seen > 0
            ? `好，切到闲聊模式～之前的聊天记录还在（${seen} 条）。想回去干活发 \`/work\`。`
            : '好，切到闲聊模式啦，随便聊点啥都行～想回去干活发 `/work`。',
          '闲聊模式',
        )
        return
      }
      case 'work': {
        chatMode = false
        await reply('切回工作模式，接下来发的消息会直接进 dsh 会话。', '工作模式')
        return
      }
      case 'mode': {
        await reply(
          chatMode
            ? '现在是**闲聊模式**，消息不会进 dsh。'
            : '现在是**工作模式**，消息会进 dsh 会话。',
          '当前模式',
        )
        return
      }
      case 'forget': {
        chat.reset(chatKey())
        await reply('闲聊记录抹掉了。', '已清空')
        return
      }
      case 'status': {
        const active = activeAgent()
        const binding = active === undefined ? undefined : registry.get(active.sessionId)
        if (binding === undefined) {
          await reply('现在还没接上任何会话哦。', '现在的状态')
          return
        }
        await reply([
          `在哪干活　${binding.cwd}`,
          `会话码　#${binding.code}`,
          `跑到哪了　${binding.turns} turn · ${binding.toolCalls} 次工具调用`,
          `还欠你　${registry.pendingCount()} 个回答`,
        ].join('\n'), '现在的状态')
        return
      }
      case 'list': {
        const rows = registry.list().slice(0, 10)
        if (rows.length === 0) {
          await reply('我还没记过任何会话呢。', '会话清单')
          return
        }
        const activeId = registry.activeSessionId()
        const body = rows.map((row) => {
          const mark = row.sessionId === activeId ? '← 就是这个' : ''
          return `**#${row.binding.code}**　${row.binding.cwd}\n　跑到 ${row.binding.turns} turn · 上次动是 ${new Date(row.binding.lastActiveAt).toLocaleString('zh-CN')} ${mark}`
        }).join('\n\n')
        await reply(body, '会话清单')
        return
      }
      case 'use': {
        const code = rest[0] ?? ''
        const found = registry.findByCode(code)
        if (found === undefined) {
          await reply(`没找到 **${code}** 这个短码呀，发 \`/list\` 看看有哪些吧。`, '没找到')
          return
        }
        registry.setActiveSession(found.sessionId)
        await reply(`好嘞，默认投递目标换成 **#${found.binding.code}** 啦 👇\n${found.binding.cwd}`, '换好啦')
        return
      }
      case 'stop': {
        const active = activeAgent()
        if (active === undefined) {
          await reply('现在没有在跑的会话哦。', '喊停')
          return
        }
        active.agent.cancel({ kind: 'user' })
        await questions.cancelForSession(active.sessionId)
        await reply(`已经把 **#${registry.get(active.sessionId)?.code ?? '----'}** 这一轮按停啦。`, '停好啦')
        return
      }
      case 'polish': {
        const active = activeAgent()
        if (active === undefined) {
          await reply('现在没有在跑的会话哦。', '润色')
          return
        }
        active.agent.followup(createUserMessage({
          content: [{ type: 'text', text: polishPrompt(persona()) }],
          source: { kind: 'user' },
        }))
        await reply('好，我让 dsh 用模型重写一版，写好了马上推给你～', '润色中')
        return
      }
      case 'mute': {
        const active = activeAgent()
        if (active === undefined) {
          await reply('现在没有在跑的会话哦。', '静一点')
          return
        }
        silenced.add(active.sessionId)
        await reply('ok，这一段我就不往飞书碎碎念了；想恢复就发 `/unmute` 喊我一声。', '静音啦')
        return
      }
      case 'unmute': {
        const active = activeAgent()
        if (active === undefined) {
          await reply('现在没有在跑的会话哦。', '恢复汇报')
          return
        }
        silenced.delete(active.sessionId)
        await reply('回来啦，继续给你汇报～', '恢复啦')
        return
      }
      default: {
        await reply(`这条指令我没听过呀：\`${raw.trim()}\`\n\n${HELP}`, '没这条指令')
      }
    }
  }

  const onText = (text: string): void => {
    void (async () => {
      // 指令优先：slash 开头的意图最明确。
      if (text.startsWith('/')) {
        await runCommand(text)
        return
      }
      // 闲聊模式：不碰 dsh，纯粹的一段对话。
      if (chatMode) {
        await chatReply(text)
        return
      }
      // 有待答问题时，任何自由文本都优先当答案。
      if (questions.answer(text)) return
      await deliver(text)
    })()
  }

  /**
   * 把一张本地图片交给 dsh 的附件服务，换回能直接进消息的图片块。
   *
   * 这一步是图片能被模型「看见」的关键：附件服务会校验格式、归一化成
   * provider 无关的位图并持久化，返回的是可直接塞进 UserMessage 的引用。
   */
  const admitImage = async (filePath: string): Promise<unknown | undefined> => {
    const service = ctx.get('attachments') as { admitPromptContent?: (parts: unknown[]) => Promise<unknown[]> } | undefined
    if (service?.admitPromptContent === undefined) {
      logger.warn('[feishu-bridge] 没有可用的附件服务，图片无法送进会话')
      return undefined
    }
    try {
      const bytes = await readFile(filePath)
      const parts = await service.admitPromptContent([{
        type: 'image',
        mediaType: sniffMediaType(bytes),
        data: bytes.toString('base64'),
        name: basename(filePath),
      }])
      return parts.find((part) => (part as { type?: string }).type === 'image')
    } catch (error) {
      logger.warn(`[feishu-bridge] 图片 admission 失败: ${String(error)}`)
      return undefined
    }
  }

  /**
   * 处理飞书发来的图片。
   *
   * 链路：事件只给 message_id → mget 取 image_key → 下载到本地 →
   * 交给附件服务 admit 成图片块 → 作为 user 消息注入会话。
   * 注意模型必须是 vision 模型：deepseek-flash 是，deepseek-v4-pro 不是。
   */
  const onImage = async (event: Record<string, unknown>): Promise<void> => {
    if (chatMode) {
      await outbox.say('闲聊模式不收图哦，想让我看图就发 /work 回去干活。')
      return
    }
    const messageId = typeof event.message_id === 'string' ? event.message_id : ''
    if (messageId.length === 0) return

    const detail = await messageGet(cli, messageId)
    const imageKey = findImageKey(detail)
    if (imageKey === undefined) {
      await reply('这张图我没接下来 —— 从消息里读不到图片资源键。', '收图失败')
      return
    }

    // 下载目标必须落在 CLI 的允许根内（cwd / tmp / ~/files），所以放 ~/files 下。
    // 后缀只是给文件一个名字：真实格式由内容决定，admit 前会按文件头嗅探。
    const dir = join(homedir(), 'files', 'dsh-feishu-bridge')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${messageId}.img`)
    if (!await downloadResource(cli, messageId, imageKey, 'image', target)) {
      await reply('图片下载失败了，可能是资源过期或权限不够。', '收图失败')
      return
    }

    const active = activeAgent()
    if (active === undefined) {
      await reply(`图我先存下了：\`${target}\`\n现在还没有活跃会话，等 dsh 里开一个再发给我吧。`, '没有目标')
      return
    }

    const block = await admitImage(target)
    if (block === undefined) {
      await reply(`图存下来了，但没能送进会话（附件服务不可用）：\`${target}\``, '收图失败')
      return
    }
    active.agent.followup(createUserMessage({
      content: [block, { type: 'text', text: '（用户从飞书发来一张图片）' }],
      source: { kind: 'user' },
    }))
    await reply(`图收到啦，已经交给 **#${registry.get(active.sessionId)?.code ?? '----'}**。`, '收到图片')
  }

  const inbox = new Inbox({
    cli,
    logger,
    eventKey: 'im.message.receive_v1',
    label: '入站',
    onEvent: (event) => {
      const sender = typeof event.sender_id === 'string' ? event.sender_id : ''
      if (sender.length === 0) return
      const bound = target.id
      if (bound.length === 0) {
        // 零配置认领：第一条消息的主人就是这台 dsh 的对接人。
        target = { kind: 'user', id: sender }
        registry.setTarget('user', sender)
        probe(`target claimed from first message: ${sender}`)
        void reply(`好，我记住你了（\`${sender}\`）～以后有活直接发给我就行。`, '绑定成功')
      } else if (sender !== bound) {
        // 只认已经绑定的那位，别人发来的消息一律不驱动会话。
        return
      }
      const messageType = typeof event.message_type === 'string' ? event.message_type : ''
      if (messageType === 'image') {
        void onImage(event)
        return
      }
      if (messageType !== '' && messageType !== 'text') return
      const content = typeof event.content === 'string' ? event.content.trim() : ''
      if (content.length === 0) return
      onText(content)
    },
  })

  // 卡片按钮回调。需要开发者在开放平台订阅 card.action.trigger，
  // 未订阅时订阅命令会直接失败，所以只给两次重试就放弃，避免刷日志。
  const cardInbox = new Inbox({
    cli,
    logger,
    eventKey: 'card.action.trigger',
    label: '卡片回调',
    maxRestarts: 2,
    onEvent: (event) => {
      const raw = typeof event.action_value === 'string' ? event.action_value : ''
      if (raw.length === 0) return
      try {
        const parsed = JSON.parse(raw) as { bridge?: { qid?: unknown; label?: unknown } }
        const bridge = parsed.bridge
        if (bridge === undefined) return
        const qid = typeof bridge.qid === 'string' ? bridge.qid : ''
        const label = typeof bridge.label === 'string' ? bridge.label : ''
        if (qid.length === 0 || label.length === 0) return
        if (questions.answerByLabel(qid, label)) {
          logger.info(`[feishu-bridge] 卡片按钮作答：${label}`)
        }
      } catch {
        // 非本插件发出的卡片，忽略即可。
      }
    },
  })

  const questions = new QuestionBridge({
    outbox,
    registry,
    logger,
    graceMs: config.questionGraceMs,
    timeoutMs: config.questionTimeoutMs,
    enabled: () => config.enabled,
  })

  /** 配置面板的挂载路径。 */
  const CONFIG_PATH = '/feishu-bridge/config'

  /**
   * 配置面板：挂在 dsh HTTP 服务上的本地页面。
   *
   * 只做「用户必须填」的两件事：**绑定谁**、**闲聊用哪个模型**。
   * 其余开关留给配置文件与飞书 `/config` 指令 —— 与其做一个半吊子的
   * 全量设置页，不如把这两项做扎实。
   */
  /** 设置页客户端用的 JSON 端点（原生面板通过它读写配置）。 */
  const CONFIG_API = '/feishu-bridge/api'

  /**
   * 装配置面板。
   *
   * @param hostCtx 带 `webServer` 的上下文 —— 必须由 `ctx.inject(['webServer'])`
   *   给进来。直接 `ctx.get('webServer')` 是不行的：插件加载顺序不保证
   *   HTTP 服务先就位，同步 apply 时经常拿到 undefined，于是路由静默缺失。
   */
  /**
   * 保存一组配置。网页表单与设置页 API 共用这一份逻辑。
   *
   * 三件事：绑定谁、用哪个 bot（profile / app id）、闲聊用哪个模型。
   * 换 bot 会重建入站流并清空绑定 —— open_id 按应用维度隔离，
   * 换了应用之后旧的 open_id 不再指向同一个人。
   */
  const applyConfig = (record: Record<string, unknown>): { switched: boolean } => {
    const pick = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string).trim() : '')

    const before = cli.profile
    const profile = pick('profile')
    registry.setOverride('profile', profile.length > 0 ? profile : undefined)
    const switched = cli.profile !== before

    let userId = pick('userId')
    if (switched) userId = ''
    target = { kind: 'user', id: userId }
    registry.setTarget('user', userId)

    registry.setOverride('chatProvider', pick('chatProvider') || undefined)
    registry.setOverride('chatModel', pick('chatModel') || undefined)
    // 人设是多行文本：首尾空白 trim 掉，行内换行保留。
    registry.setOverride('persona', pick('persona') || undefined)
    probe(`config saved (profile=${cli.profile}, userId=${userId.length > 0 ? userId : 'unbound'})`)

    if (switched) {
      // 入站流挂在旧应用上，不重建就永远收不到新 bot 的消息。
      void inbox.stop().then(() => {
        inbox.start()
        probe(`profile switched to ${cli.profile}, inbox restarted`)
      })
    }
    return { switched }
  }

  const installConfigPage = (hostCtx: Context): void => {
    const webServer = hostCtx.get('webServer') as {
      register?: (route: {
        kind: 'exact'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
      }) => unknown
    } | undefined
    if (webServer?.register === undefined) {
      logger.warn('[feishu-bridge] 没有可用的 webServer 服务，配置面板未注册')
      return
    }
    const state = (notice?: string): ConfigPageState => ({
      userId: target.id,
      profile: cli.profile,
      appId: resolvedAppId,
      botName,
      chatProvider: registry.overrides().chatProvider ?? config.chatProvider,
      chatModel: registry.overrides().chatModel ?? config.chatModel,
      persona: persona(),
      statePath: registry.location(),
      ...notice === undefined ? {} : { notice },
    })
    ctx.effect(() => webServer.register?.({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: async (req, res) => {
        try {
          if ((req.method ?? 'GET').toUpperCase() === 'POST') {
            const params = new URLSearchParams(await readBody(req))
            const record: Record<string, unknown> = {}
            for (const [key, value] of params) record[key] = value
            applyConfig(record)
            res.writeHead(303, { location: `${CONFIG_PATH}?saved=1` })
            res.end()
            return
          }
          const saved = new URL(req.url ?? CONFIG_PATH, 'http://127.0.0.1').searchParams.get('saved') === '1'
          sendHtml(res, 200, renderConfigPage(state(saved ? '已保存。' : undefined), CONFIG_PATH))
        } catch (error) {
          logger.warn(`[feishu-bridge] 配置面板处理失败: ${String(error)}`)
          sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><p>请求处理失败，详情看 dsh 日志。')
        }
      },
    }))
    logger.info(`[feishu-bridge] 配置面板已挂载：${CONFIG_PATH}`)
    probe(`config endpoints registered: ${CONFIG_PATH} + ${CONFIG_API}`)

    // 同一份读写逻辑再开一个 JSON 端点，给 dsh 设置页里的原生面板用。
    ctx.effect(() => webServer.register?.({
      kind: 'exact',
      path: CONFIG_API,
      handler: async (req, res) => {
        const send = (status: number, body: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        try {
          const method = (req.method ?? 'GET').toUpperCase()
          if (method === 'GET') {
            send(200, { ok: true, config: state() })
            return
          }
          if (method !== 'POST') {
            send(405, { ok: false, error: 'method not allowed' })
            return
          }
          const body: unknown = JSON.parse(await readBody(req))
          const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
          const { switched } = applyConfig(record)
          send(200, { ok: true, config: state(), switched })
        } catch (error) {
          logger.warn(`[feishu-bridge] 配置接口处理失败: ${String(error)}`)
          send(400, { ok: false, error: String(error) })
        }
      },
    }))
  }

  if (config.enabled) {
    questions.install(ctx)
    reporter.install(ctx)
    // 等 webServer 就绪再装：加载顺序不保证它先到，同步 ctx.get 常常拿不到。
    ctx.inject(['webServer'], (hostCtx: Context) => { installConfigPage(hostCtx) })

    // 整段包在 try 里：提示词注入失败绝不能连累插件加载 ——
    // 变量名不合规这类错误会一路抛到 apply 外面，整个插件就不激活了。
    if (config.promptSection) {
      try {
        const systemPrompt = ctx.get('systemPrompt') as {
          section?: (input: { name: string; order: number; text: string }) => unknown
          variable?: (name: string, resolve: () => unknown) => unknown
        } | undefined
        if (systemPrompt?.section !== undefined) {
          // 变量可用时用变量（启动后拿到真名也能生效）；不可用就退化成静态替换。
          // 必须二选一：留下未注册的 `{{...}}` 会让整个提示词组装抛错，
          // 那不只是本插件失效，而是所有会话都拿不到系统提示。
          //
          // 变量名必须匹配 /^[a-z][a-z0-9_]*$/（全小写、下划线分隔）——
          // 踩过一次：大写字母会让注册直接抛错。
          let useVariable = typeof systemPrompt.variable === 'function'
          if (useVariable) {
            try {
              ctx.effect(() => systemPrompt.variable?.('feishu_bot_name', () => botName))
            } catch (error) {
              useVariable = false
              logger.warn(`[feishu-bridge] 提示词变量注册失败，改用静态替换：${String(error)}`)
              probe(`prompt variable failed: ${String(error)}`)
            }
          }
          ctx.effect(() => systemPrompt.section?.({
            name: 'feishu-bridge:notify-policy',
            order: 9000,
            text: useVariable
              ? FEISHU_PROMPT_SECTION
              : FEISHU_PROMPT_SECTION.replaceAll('{{feishu_bot_name}}', botName),
          }))
          probe(`prompt section registered (variable=${String(useVariable)})`)
        } else {
          logger.warn('[feishu-bridge] 没有可用的 systemPrompt 服务，跳过提示词注入')
        }
      } catch (error) {
        logger.warn(`[feishu-bridge] 提示词注入失败（其余功能不受影响）：${String(error)}`)
        probe(`prompt section failed: ${String(error)}`)
      }
    }
    registerTools(ctx, {
      enabled: () => config.enabled,
      persona,
      notify: async (input, sessionId) => {
        if (!config.progressPush) return { delivered: false, detail: '阶段结论推送已关闭' }
        const binding = registry.ensure(sessionId, '')
        const changes = resolveChanges(sessionId, binding.lastChangesSeq)
        const card = progressCardOf(input, binding, changes)
        const outcome = await pushProgress(sessionId, input.kind, card)
        if (outcome.messageId === undefined) return { delivered: false, detail: '推送失败，检查 lark-cli 状态' }
        // 记下这个 turn 已经播报过，judge 兜底就不再重复问一遍。
        registry.touch(sessionId, { lastNotifyTurn: registry.get(sessionId)?.lastTurn ?? 0 })
        return { delivered: true, detail: `已推送（${outcome.messageId}）` }
      },
      summarize: (sessionId) => pushSummary(sessionId, 'tool'),
      silence: (off, sessionId) => {
        if (off) silenced.add(sessionId)
        else silenced.delete(sessionId)
        logger.info(`[feishu-bridge] 会话 ${sessionId} 的飞书汇报已${off ? '静默' : '恢复'}`)
        return Promise.resolve({ detail: off ? '已静默这个会话的飞书汇报' : '已恢复这个会话的飞书汇报' })
      },
    })
  }

  ctx.effect(() => {
    void (async () => {
      await registry.load()
      chat.load(registry.chatStore() as ChatStore | undefined)
      probe('state loaded')
      const saved = registry.target()
      target = saved.id.length > 0 ? saved : { kind: 'user', id: config.userId }
      if (config.userId.length > 0) registry.setTarget('user', config.userId)
      if (!config.enabled) {
        probe('disabled by config')
        logger.info('[feishu-bridge] 已关闭（config.enabled = false），不启动入站监听')
        return
      }
      if (target.id.length === 0) {
        // 开源场景不该逼用户先去查自己的 open_id：给 bot 发任意一条消息就自动认领。
        probe('no target yet, will auto-claim from first message')
        logger.info('[feishu-bridge] 还没绑定用户 —— 给机器人发任意一条消息即可自动认领')
      }
      const me = await whoami({ ...cli, timeoutMs: 15000 })
      probe(`whoami: ${JSON.stringify(me)} cliEntry=${cli.entry}`)
      if (me?.appId === undefined || me.available !== true) {
        logger.error(`[feishu-bridge] lark-cli 身份校验失败（profile=${config.profile}），桥接未启动`)
        return
      }
      if (disposed) return
      resolvedAppId = me.appId
      // 顺带把机器人的真实名字问回来，填进提示词，省得插件里硬编码。
      const info = await botInfo({ ...cli, timeoutMs: 15000 })
      if (info?.name !== undefined) {
        botName = info.name
        probe(`bot name resolved: ${info.name}`)
      }
      probe('starting inbox')
      logger.info(`[feishu-bridge] 大肥鲸就绪：profile=${config.profile} app=${me.appId}`)
      const lockPath = join(STATE_DIR, 'inbox.lock')
      if (acquireInboxLock(lockPath, logger)) {
        inbox.start()
        cardInbox.start()
        probe('inbox lock acquired, streams started')
        // 上线问候交给模型现写：每次重启都念同一句太糙了。
        const boot = registry.noteBoot()
        const now = new Date()
        const pad = (n: number) => String(n).padStart(2, '0')
        const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
        const greetingMaterial = [
          `现在：${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} ${weekdays[now.getDay()]}`,
          `工作区：${process.cwd()}`,
          `这是第 ${boot.count} 次启动`,
          ...boot.previousAt === undefined
            ? []
            : [`上次启动：${new Date(boot.previousAt).toLocaleString('zh-CN')}`, `隔了：${humanGap(now.getTime() - boot.previousAt)}`],
        ].join('\n')
        const angle = GREETING_ANGLES[Math.floor(Math.random() * GREETING_ANGLES.length)]
        const greeting = await writer.compose(
          `${GREETING_INSTRUCTION}\n\n这次的角度：${angle}`,
          greetingMaterial,
          '我在的，有事喊我。',
          bootRoute(),
        )
        probe(`greeting: ${greeting}`)
        if (target.id.length === 0) {
          // 还没绑定任何人：无处可发。等第一条消息自动认领时再打招呼。
          probe('no bound user yet, online notice skipped')
        } else {
          await outbox.reply(noticeCard(`${greeting}\n\n直接发消息就是跟当前会话说话；想看我都会啥，发 \`/help\`。`, '大肥鲸上线', 'green'))
          probe('online notice sent')
        }
      } else {
        logger.info('[feishu-bridge] 另一个 dsh 实例正在消费飞书消息，本实例只做本地会话的播报')
        probe('inbox lock held by another instance')
      }
    })().catch((error: unknown) => {
      probe(`bootstrap failed: ${String(error)}`)
      logger.error(`[feishu-bridge] 启动失败: ${String(error)}`)
    })

    return () => {
      disposed = true
      void inbox.stop()
      void cardInbox.stop()
      releaseInboxLock(join(STATE_DIR, 'inbox.lock'))
      reporter.dispose()
      void registry.flush()
    }
  })

  /** 组装阶段结论卡（把 registry 的会话信息补进卡片）。 */
  function progressCardOf(
    input: { title: string; text: string },
    binding: { cwd: string; code: string; lastTurn: number },
    changes: ChangeSet | undefined,
  ): string {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return progressCard({
      title: input.title,
      body: input.text,
      cwd: binding.cwd.length > 0 ? binding.cwd : process.cwd(),
      code: binding.code,
      turn: binding.lastTurn,
      at: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      ...changes === undefined ? {} : { changes },
    })
  }
}

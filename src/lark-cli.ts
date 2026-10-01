/**
 * lark-cli 适配层 —— 全插件唯一与飞书 CLI 接触的地方。
 *
 * 三条硬约束，全部是实测踩出来的（PLAN.md 风险 X2、F3、F21）：
 *  1. 必须 Node 直调 `node <cli>/scripts/run.js`。走 lark-cli.ps1 / .cmd 会被
 *     包装层把正常 stderr 变成 NativeCommandError；而 Windows PowerShell 5.1
 *     传原生参数时还会吞掉 JSON 双引号，导致 --content 永远 "not valid JSON"。
 *     spawn + argv 数组完全绕开 shell，是唯一可靠通道。
 *  2. 每次调用都显式带 `--profile`，绝不依赖全局 active profile，
 *     否则会串到另一个在用的飞书 bot。
 *  3. 长驻的事件流子进程只能通过 stdin 关闭或 SIGTERM 结束，绝不能 kill -9，
 *     否则会漏掉服务端订阅清理。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 全局 npm 安装下的两条候选路径：优先原生二进制，其次转发脚本。 */
const CLI_BIN_TAIL = ['npm', 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli']
const RUN_JS_TAIL = ['npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js']

export interface CliOptions {
  /** CLI 入口 run.js 绝对路径。 */
  entry: string
  /**
   * lark-cli profile 名，决定用哪个飞书应用。
   *
   * 声明成 readonly 是有意的：调用方可以传一个 getter，让 profile 在
   * 每次调用时重新求值 —— 用户改了绑定的 bot 就立刻生效，不用重启。
   */
  readonly profile: string
  signal?: AbortSignal
  timeoutMs?: number
}

export interface CliResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  json?: Record<string, unknown>
}

/** 投递目标：私聊（open_id）或群（chat_id）。 */
export interface Target {
  kind: 'user' | 'chat'
  id: string
}

/** 全局 npm 根目录候选。 */
function npmRoots(): string[] {
  return [
    process.env.APPDATA ?? '',
    process.env.USERPROFILE === undefined ? '' : join(process.env.USERPROFILE, 'AppData', 'Roaming'),
  ].filter((root) => root.length > 0)
}

/**
 * 探测 CLI 入口。
 *
 * **优先返回原生二进制**（`bin/lark-cli.exe`），只有找不到时才退回 `scripts/run.js`
 * —— 直连二进制并自己带 `windowsHide`，才不会在桌面版里弹出控制台窗口。
 */
export function resolveCliEntry(configured: string): string {
  if (configured.length > 0) return configured
  const roots = npmRoots()
  for (const root of roots) {
    const candidate = join(root, ...CLI_BIN_TAIL) + (process.platform === 'win32' ? '.exe' : '')
    if (existsSync(candidate)) return candidate
  }
  for (const root of roots) {
    const candidate = join(root, ...RUN_JS_TAIL)
    if (existsSync(candidate)) return candidate
  }
  return join(roots[0] ?? '', ...RUN_JS_TAIL)
}

/**
 * 起一个 CLI 子进程。
 *
 * 入口是脚本（`.js`）就用宿主的 node 跑；是原生二进制就**直接执行**。
 * 两种都带 `windowsHide` —— 这是桌面版不弹控制台的关键。
 */
function spawnCli(
  opts: CliOptions,
  args: string[],
  stdio: 'ignore' | 'pipe' | Array<'ignore' | 'pipe'>,
): ChildProcess {
  const isScript = /\.(?:js|mjs|cjs)$/i.test(opts.entry)
  const spawnOptions = { windowsHide: true, stdio } as const
  const argv = ['--profile', opts.profile, ...args]
  return isScript
    ? spawn(process.execPath, [opts.entry, ...argv], spawnOptions)
    : spawn(opts.entry, argv, spawnOptions)
}

/** 从 CLI 的 stdout 里取出结果 JSON（CLI 正常路径只输出一个 JSON 文档）。 */
function parseJson(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim()
  if (text.length === 0) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    // 个别子命令会额外打印一行日志，退化为取最后一个 JSON 对象。
    const start = text.lastIndexOf('\n{')
    if (start < 0) return undefined
    try {
      const value: unknown = JSON.parse(text.slice(start + 1))
      return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }
}

/** 跑一条一次性的 lark-cli 命令，收集完整输出。 */
export function runLark(args: string[], opts: CliOptions): Promise<CliResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawnCli(opts, args, ['ignore', 'pipe', 'pipe'])

    const timer = opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => { child.kill('SIGTERM') }, opts.timeoutMs)
    const onAbort = () => { child.kill('SIGTERM') }
    if (opts.signal?.aborted === true) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (exitCode: number | null, extra?: string) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      const json = parseJson(stdout)
      resolve({
        ok: exitCode === 0 && json?.ok !== false,
        exitCode,
        stdout,
        stderr: extra === undefined ? stderr : `${stderr}\n${extra}`,
        ...json === undefined ? {} : { json },
      })
    }

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error: Error) => { finish(null, `spawn failed: ${error.message}`) })
    child.on('close', (code) => { finish(code) })
  })
}

/** 起一个长驻 lark-cli 子进程（事件流用），调用方负责读 stdout 与收尾。 */
export function spawnLarkStream(args: string[], opts: CliOptions): ChildProcess {
  // stdin 留 pipe：关闭它就是这个子进程约定的优雅退出信号。
  return spawnCli(opts, args, ['pipe', 'pipe', 'pipe'])
}

/** 去掉开头的 `🐋 大肥鲸` 署名与换行，并把过长正文截断，保证卡片不超 30KB。 */
function safeCard(cardJson: string): string {
  const MAX = 28000
  if (cardJson.length <= MAX) return cardJson
  // 极端长卡：截掉正文再重试，宁可少一段也不要发送失败。
  return cardJson.slice(0, MAX)
}

function targetArgs(target: Target): string[] {
  return target.kind === 'user' ? ['--user-id', target.id] : ['--chat-id', target.id]
}

/** 发一张交互卡片，返回 message_id（失败返回 undefined）。 */
export async function sendCard(opts: CliOptions, target: Target, cardJson: string, idempotencyKey?: string): Promise<string | undefined> {
  const args = [
    'im', '+messages-send',
    '--as', 'bot',
    ...targetArgs(target),
    '--msg-type', 'interactive',
    '--content', safeCard(cardJson),
  ]
  if (idempotencyKey !== undefined) args.push('--idempotency-key', idempotencyKey.slice(0, 50))
  const result = await runLark(args, opts)
  const data = result.json?.data
  if (!result.ok || typeof data !== 'object' || data === null) return undefined
  const messageId = (data as Record<string, unknown>).message_id
  return typeof messageId === 'string' ? messageId : undefined
}

/** 发一条纯文本（仅用于极短回执，正式推送一律用卡片）。 */
export async function sendText(opts: CliOptions, target: Target, text: string): Promise<string | undefined> {
  const result = await runLark([
    'im', '+messages-send',
    '--as', 'bot',
    ...targetArgs(target),
    '--text', text,
  ], opts)
  const data = result.json?.data
  if (!result.ok || typeof data !== 'object' || data === null) return undefined
  const messageId = (data as Record<string, unknown>).message_id
  return typeof messageId === 'string' ? messageId : undefined
}

/** 原地更新已发出的卡片（14 天内、30KB 内）。 */
export async function patchCard(opts: CliOptions, messageId: string, cardJson: string): Promise<boolean> {
  const result = await runLark([
    'im', 'messages', 'patch',
    '--as', 'bot',
    '--message-id', messageId,
    '--data', JSON.stringify({ content: safeCard(cardJson) }),
  ], opts)
  return result.ok
}

/**
 * 取一条消息的原始体。
 *
 * 图片消息的 `image_key` 只在这里 —— 事件里的 `content` 字段是预渲染的
 * 人类可读文本，拿不到资源键。注意 `mget` 的结果在 `data.messages`
 * （不是 `data.items`，那是别的命令的形状）。
 */
export async function messageGet(opts: CliOptions, messageId: string): Promise<Record<string, unknown> | undefined> {
  const result = await runLark(['im', '+messages-mget', '--message-ids', messageId], opts)
  const data = result.json?.data
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { messages?: unknown; items?: unknown }
  const list = Array.isArray(record.messages)
    ? record.messages
    : Array.isArray(record.items) ? record.items : []
  if (list.length === 0) return undefined
  const first: unknown = list[0]
  return typeof first === 'object' && first !== null ? first as Record<string, unknown> : undefined
}

/**
 * 下载消息里的一个资源到本地。
 *
 * `--type` 是必需参数 —— 尽管 `--help` 的 Flags 列表里没列它（只有示例里出现），
 * 漏传会直接报 `required flag(s) "type" not set`。
 *
 * @param outputPath 目标路径，必须落在 CLI 的允许根内（cwd / tmp / ~/files）。
 */
export async function downloadResource(
  opts: CliOptions,
  messageId: string,
  fileKey: string,
  kind: 'image' | 'file',
  outputPath: string,
): Promise<boolean> {
  const result = await runLark([
    'im', '+messages-resources-download',
    '--as', 'bot',
    '--message-id', messageId,
    '--file-key', fileKey,
    '--type', kind,
    '--output', outputPath,
  ], opts)
  return result.ok
}

/**
 * 取机器人自身的信息。
 *
 * 用 raw API 而不是封装命令：`GET /open-apis/bot/v3/info` 返回 `app_name`
 * （机器人在飞书里显示的名字）、`avatar_url` 和机器人自己的 `open_id`。
 * 名字用来填进提示词，免得插件里硬编码一遍。
 */
export async function botInfo(opts: CliOptions): Promise<{ name?: string; openId?: string } | undefined> {
  const result = await runLark(['api', 'GET', '/open-apis/bot/v3/info'], opts)
  const data = result.json?.data
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { app_name?: unknown; open_id?: unknown }
  return {
    name: typeof record.app_name === 'string' && record.app_name.length > 0 ? record.app_name : undefined,
    openId: typeof record.open_id === 'string' && record.open_id.length > 0 ? record.open_id : undefined,
  }
}

/** 校验身份：确认指定 profile 解析到了预期的应用，且 bot 身份可用。 */
export async function whoami(opts: CliOptions): Promise<{ appId?: string; profile?: string; identity?: string; available?: boolean } | undefined> {
  const result = await runLark(['whoami'], opts)
  if (result.json === undefined) return undefined
  const json = result.json
  return {
    appId: typeof json.appId === 'string' ? json.appId : undefined,
    profile: typeof json.profile === 'string' ? json.profile : undefined,
    identity: typeof json.identity === 'string' ? json.identity : undefined,
    available: json.available === true,
  }
}

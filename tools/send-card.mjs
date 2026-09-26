/**
 * M0 冒烟脚本：用 Node 直调 lark-cli 发一张交互卡片。
 *
 * 两条理由都会原样复制进正式插件（见 PLAN.md 风险 X2）：
 *  1. Windows 上必须绕开 lark-cli.ps1 / .cmd 包装，直接跑
 *     `node <cli>/scripts/run.js`，否则正常 stderr 会被 shell 包装成
 *     NativeCommandError，错误判定被污染。
 *  2. 只能走 argv 数组传 JSON。PowerShell 5.1 传原生参数时会吞掉双引号，
 *     手写 `--content '{...}'` 必然得到 "not valid JSON"。
 *
 * 用法：
 *   node tools/send-card.mjs <user-open-id> <card.json> [profile]
 *   LARK_CLI_RUN=<run.js 路径> 可覆盖 CLI 入口探测结果。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [userId, cardPath, profile = process.env.LARK_PROFILE ?? 'dsh-bridge'] = process.argv.slice(2)

if (!userId || !cardPath) {
  console.error('usage: node send-card.mjs <user-open-id> <card.json> [profile]')
  process.exit(2)
}

const runJs = process.env.LARK_CLI_RUN
  ?? `${process.env.APPDATA}\\npm\\node_modules\\@larksuite\\cli\\scripts\\run.js`

const result = spawnSync(process.execPath, [
  runJs,
  '--profile', profile,
  'im', '+messages-send',
  '--as', 'bot',
  '--user-id', userId,
  '--msg-type', 'interactive',
  '--content', readFileSync(cardPath, 'utf8').trim(),
], { encoding: 'utf8' })

process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
process.exit(result.status ?? 1)

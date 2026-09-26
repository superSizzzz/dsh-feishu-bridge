/**
 * 配置面板：一个自包含的本地网页，挂在 dsh 的 HTTP 服务上。
 *
 * 为什么是网页而不是原生的 dsh 设置页：原生面板要写一个独立的 client-ui
 * 插件（前端 bundle + 构建链路），而开源用户真正要填的东西很少 ——
 * 「绑定谁」和「闲聊用哪个模型」两项就够。用一个无构建的内联 HTML 页面
 * 覆盖这两项，性价比高得多。
 *
 * 安全边界：dsh 的 webServer 默认只绑 127.0.0.1（loopback），所以本页
 * 没有做认证 —— 能打开这个页面的人本来就能用这台机器上的 dsh。
 * 若把 webServer 配成 0.0.0.0，本页也会随之暴露，README 里写明了这一点。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 一次渲染需要的全部事实。 */
export interface ConfigPageState {
  /** 当前绑定的 open_id；空表示还没认领。 */
  userId: string
  /** lark-cli profile 名。 */
  profile: string
  /** 解析到的 app id（只读展示）。 */
  appId: string
  /** 机器人在飞书里的显示名。 */
  botName: string
  /** 闲聊模型的 provider / model 覆盖项。 */
  chatProvider: string
  chatModel: string
  /** 飞书侧的说话口吻（人设）。 */
  persona: string
  /** 状态文件路径（只读展示）。 */
  statePath: string
  /** 保存后的提示语。 */
  notice?: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 20px; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  background: #f6f7f9; color: #1f2329; }
main { max-width: 640px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
p.sub { margin: 0 0 24px; color: #646a73; font-size: 13px; }
section { background: #fff; border: 1px solid #e5e6eb; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
h2 { font-size: 14px; margin: 0 0 14px; color: #1f2329; }
label { display: block; font-size: 13px; color: #646a73; margin-bottom: 6px; }
input[type=text], select { width: 100%; padding: 8px 10px; font-size: 13px; font-family: inherit;
  border: 1px solid #dee0e3; border-radius: 6px; background: #fff; color: inherit; }
textarea { width: 100%; padding: 8px 10px; font-size: 13px; font-family: inherit; line-height: 1.6;
  border: 1px solid #dee0e3; border-radius: 6px; background: #fff; color: inherit; resize: vertical; }
textarea:focus { outline: 2px solid #3370ff33; border-color: #3370ff; }
input[type=text]:focus, select:focus { outline: 2px solid #3370ff33; border-color: #3370ff; }
.field { margin-bottom: 16px; }
.hint { margin: 6px 0 0; font-size: 12px; color: #8f959e; }
.kv { display: flex; gap: 8px; font-size: 13px; margin-bottom: 8px; }
.kv b { min-width: 96px; font-weight: 500; color: #646a73; }
.kv span { color: #1f2329; word-break: break-all; }
code { background: #f2f3f5; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
button { padding: 9px 18px; font-size: 13px; font-family: inherit; border-radius: 6px;
  border: 1px solid #3370ff; background: #3370ff; color: #fff; cursor: pointer; }
button:hover { background: #245bdb; }
.notice { background: #e8f3ff; border: 1px solid #b8d4ff; color: #1f2329;
  padding: 10px 12px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
@media (prefers-color-scheme: dark) {
  body { background: #17181a; color: #e5e6eb; }
  section { background: #1f2023; border-color: #2f3033; }
  h2, .kv span { color: #e5e6eb; }
  input[type=text], select { background: #17181a; border-color: #3a3b3e; color: #e5e6eb; }
  code { background: #2a2b2e; }
  .notice { background: #1a2b3d; border-color: #2f4a6b; }
}
`

/** 渲染整个页面。表单用 POST 提交，保存后重定向回本页。 */
export function renderConfigPage(state: ConfigPageState, action: string): string {
  const notice = state.notice === undefined ? '' : `<div class="notice">${escapeHtml(state.notice)}</div>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>大肥鲸 · 飞书桥配置</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>大肥鲸 · 飞书桥配置</h1>
  <p class="sub">改完点保存即刻生效（绑定目标与闲聊模型无需重启）。</p>
  ${notice}

  <section>
    <h2>当前状态</h2>
    <div class="kv"><b>机器人</b><span>${escapeHtml(state.botName)}</span></div>
    <div class="kv"><b>App ID</b><span>${escapeHtml(state.appId.length > 0 ? state.appId : '（未解析到）')}</span></div>
    <div class="kv"><b>状态文件</b><span>${escapeHtml(state.statePath)}</span></div>
  </section>

  <form method="post" action="${escapeHtml(action)}">
    <section>
      <h2>飞书机器人</h2>
      <div class="field">
        <label for="profile">lark-cli profile（或 bot 的 app id）</label>
        <input type="text" id="profile" name="profile" value="${escapeHtml(state.profile)}"
               placeholder="dsh-bridge" autocomplete="off" spellcheck="false">
        <p class="hint">这个桥用哪个飞书应用。填 lark-cli 的 profile 名，
        也可以直接填 bot 的 app id（形如 <code>cli_xxxxxxxxxxxxxxxx</code>）——
        profile 名默认就是 app id。<br>
        <b>换它等于换一个 bot</b>：入站连接会重建，「绑定的人」也会被清空
        （open_id 按应用维度隔离，换应用后旧 id 不再有效），需要重新发一句话认领。
        留空则回到配置文件里的默认值。</p>
      </div>
    </section>

    <section>
      <h2>绑定的人</h2>
      <div class="field">
        <label for="userId">飞书 open_id</label>
        <input type="text" id="userId" name="userId" value="${escapeHtml(state.userId)}"
               placeholder="ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" autocomplete="off" spellcheck="false">
        <p class="hint">留空 = 解绑，下一个给机器人发消息的人会被自动认领。<br>
        不知道自己的 open_id？直接给机器人发一句话就行，它会自己记住，不用填。</p>
      </div>
    </section>

    <section>
      <h2>口吻人设</h2>
      <div class="field">
        <label for="persona">飞书侧的说话口吻</label>
        <textarea id="persona" name="persona" rows="7"
                  placeholder="例如：和用户一起工作的女高中生，说话轻松活泼、口语化">${escapeHtml(state.persona)}</textarea>
        <p class="hint">所有推给你的文案（开工报告、阶段总结、工作汇报、闲聊）都用这个口吻写。
        留空则回到配置文件里的默认人设。<b>含隐私或不想外传的内容不要写在这里</b> ——
        它是纯本地配置，但会出现在导出的状态文件里。</p>
      </div>
    </section>

    <section>
      <h2>闲聊模型</h2>
      <p class="hint" style="margin-top:0">留空则沿用 dsh 的默认模型。工作模式的模型请到 dsh 自己的设置页改。</p>
      <div class="field">
        <label for="chatProvider">provider</label>
        <input type="text" id="chatProvider" name="chatProvider" value="${escapeHtml(state.chatProvider)}"
               placeholder="deepseek-official" autocomplete="off" spellcheck="false">
      </div>
      <div class="field">
        <label for="chatModel">model</label>
        <input type="text" id="chatModel" name="chatModel" value="${escapeHtml(state.chatModel)}"
               placeholder="deepseek-flash" autocomplete="off" spellcheck="false">
      </div>
    </section>

    <button type="submit">保存</button>
  </form>
</main>
</body>
</html>`
}

/** 读取请求体（带上限，避免一个坏请求把内存吃满）。 */
export function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/** 统一的 HTML 响应头。 */
export function htmlHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  }
}

/** 发送一段 HTML。 */
export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, htmlHeaders())
  res.end(html)
}

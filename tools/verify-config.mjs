/**
 * 端到端验证配置接口：登录拿 cookie → GET 读 → POST 回写 → 看回执。
 *
 * 用法：
 *   node tools/verify-config.mjs <base-url> <token> <userId> [profile]
 *
 * 例：
 *   node tools/verify-config.mjs http://127.0.0.1:3080 '<登录 token>' 'ou_xxx' dsh-bridge
 *
 * 只回写给定值（不改 profile 就传当前值），不会动绑定关系。
 */
const [, , base, token, userId, profile = 'dsh-bridge', persona = ''] = process.argv
if (base === undefined || token === undefined || userId === undefined) {
  console.error('用法: node tools/verify-config.mjs <base-url> <token> <userId> [profile] [persona]')
  process.exit(1)
}

const page = await fetch(`${base}/?token=${token}`)
const cookies = page.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ')
const headers = { cookie: cookies, accept: 'application/json' }

const before = await fetch(`${base}/feishu-bridge/api`, { headers })
console.log('GET  ->', before.status)
console.log('     ', (await before.text()).slice(0, 260))

// 只带上明确给了值的字段：没传 persona 就完全不动它，免得把用户设好的人设清掉。
const payload = { profile, userId, chatProvider: '', chatModel: '' }
if (persona.length > 0) payload.persona = persona
const after = await fetch(`${base}/feishu-bridge/api`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})
console.log('POST ->', after.status)
console.log('     ', (await after.text()).slice(0, 260))

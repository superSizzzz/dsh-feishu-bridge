/**
 * dsh 设置页里的「飞书桥」区块。
 *
 * 这是插件的客户端一半，由 dsh 的客户端模块系统加载（`dsh.client` +
 * `exports["./client"]` 声明在 package.json 里）。它是**手写**的，不是
 * 构建产物 —— 用 `react.createElement` 代替 JSX，就省掉了一整条打包链路。
 *
 * 与宿主的两条通道：
 *  - `ctx.slots`：把本区块注册进设置页（插槽名 `settings.section`）
 *  - `/feishu-bridge/api`：读写配置的 JSON 端点（服务端那一半提供的）
 *
 * 可改的只有两项：绑定的人、闲聊模型。其余开关留在配置文件里 ——
 * 与其做一个半吊子的全量设置页，不如把用户真正要填的做扎实。
 */
window.__ModuleLoader__.load({
  id: 'dsh-feishu-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const API = '/feishu-bridge/api'
    const NS = '@deepseek-ai/dsh-feishu-bridge'

    const style = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '640px', width: '100%' },
      head: { display: 'flex', flexDirection: 'column', gap: '4px' },
      title: { fontSize: '14px', fontWeight: 600, margin: 0 },
      desc: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, #646a73)', margin: 0 },
      card: {
        border: '1px solid var(--dsw-alias-border-secondary, #e5e6eb)',
        borderRadius: '10px',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      },
      field: { display: 'flex', flexDirection: 'column', gap: '6px' },
      label: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #646a73)' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        fontSize: '13px',
        fontFamily: 'inherit',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-secondary, #dee0e3)',
        borderRadius: '6px',
      },
      hint: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8f959e)', margin: 0 },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        fontSize: '13px',
        fontFamily: 'inherit',
        lineHeight: '1.6',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-secondary, #dee0e3)',
        borderRadius: '6px',
        resize: 'vertical',
      },
      row: { display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '13px' },
      key: { minWidth: '104px', color: 'var(--dsw-alias-label-secondary, #646a73)' },
      val: { wordBreak: 'break-all' },
      actions: { display: 'flex', alignItems: 'center', gap: '12px' },
      button: {
        padding: '8px 18px',
        fontSize: '13px',
        fontFamily: 'inherit',
        color: '#fff',
        background: '#3370ff',
        border: '1px solid #3370ff',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      notice: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #646a73)' },
      error: { fontSize: '13px', color: '#d83931' },
    }

    /** 一行只读信息。 */
    const infoRow = (label, value) => h('div', { style: style.row, key: label }, [
      h('span', { style: style.key, key: 'k' }, label),
      h('span', { style: style.val, key: 'v' }, value),
    ])

    /** 一个带说明的输入框。 */
    const inputField = (options) => h('div', { style: style.field, key: options.name }, [
      h('label', { style: style.label, htmlFor: options.name, key: 'l' }, options.label),
      h('input', {
        key: 'i',
        id: options.name,
        style: style.input,
        type: 'text',
        value: options.value,
        placeholder: options.placeholder,
        spellCheck: false,
        autoComplete: 'off',
        disabled: options.disabled === true,
        onChange: (event) => options.onChange(event.target.value),
      }),
      options.hint === undefined ? null : h('p', { style: style.hint, key: 'h' }, options.hint),
    ])

    /** 一个带说明的多行输入框。 */
    const textAreaField = (options) => h('div', { style: style.field, key: options.name }, [
      h('label', { style: style.label, htmlFor: options.name, key: 'l' }, options.label),
      h('textarea', {
        key: 't',
        id: options.name,
        style: style.textarea,
        rows: options.rows === undefined ? 6 : options.rows,
        value: options.value,
        placeholder: options.placeholder,
        spellCheck: false,
        onChange: (event) => options.onChange(event.target.value),
      }),
      options.hint === undefined ? null : h('p', { style: style.hint, key: 'h' }, options.hint),
    ])

    function FeishuSection() {
      const [config, setConfig] = react.useState(null)
      const [draft, setDraft] = react.useState({ profile: '', userId: '', chatProvider: '', chatModel: '', persona: '' })
      const [state, setState] = react.useState({ busy: false, error: '', notice: '' })

      const load = react.useCallback(() => {
        fetch(API, { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((data) => {
            if (data && data.ok === true && data.config) {
              setConfig(data.config)
              setDraft({
                profile: data.config.profile || '',
                userId: data.config.userId || '',
                chatProvider: data.config.chatProvider || '',
                chatModel: data.config.chatModel || '',
                persona: data.config.persona || '',
              })
              setState({ busy: false, error: '', notice: '' })
              return
            }
            setState({ busy: false, error: (data && data.error) || '读取配置失败', notice: '' })
          })
          .catch((error) => {
            setState({ busy: false, error: String(error), notice: '' })
          })
      }, [])

      react.useEffect(() => { load() }, [load])

      const save = () => {
        setState({ busy: true, error: '', notice: '' })
        fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(draft),
        })
          .then((res) => res.json())
          .then((data) => {
            if (data && data.ok === true) {
              if (data.config) setConfig(data.config)
              setState({ busy: false, error: '', notice: '已保存，即刻生效。' })
              return
            }
            setState({ busy: false, error: (data && data.error) || '保存失败', notice: '' })
          })
          .catch((error) => {
            setState({ busy: false, error: String(error), notice: '' })
          })
      }

      if (config === null) {
        return h('div', { style: style.wrap }, [
          h('div', { style: style.head, key: 'head' }, [
            h('h3', { style: style.title, key: 't' }, '飞书桥'),
            h('p', { style: style.desc, key: 'd' }, state.error.length > 0 ? state.error : '正在读取配置…'),
          ]),
        ])
      }

      return h('div', { style: style.wrap }, [
        h('div', { style: style.head, key: 'head' }, [
          h('h3', { style: style.title, key: 't' }, '飞书桥'),
          h('p', { style: style.desc, key: 'd' },
            '让 dsh 通过飞书机器人「' + (config.botName || '大肥鲸') + '」跟你协作的桥接插件。'
            + '下面两项改完点保存即刻生效，不用重启。'),
        ]),

        h('div', { style: style.card, key: 'status' }, [
          h('div', { style: style.title, key: 't' }, '当前状态'),
          infoRow('app id', config.appId || '（未解析到）'),
          infoRow('状态文件', config.statePath || '（默认）'),
        ]),

        h('div', { style: style.card, key: 'bot' }, [
          h('div', { style: style.title, key: 't' }, '飞书机器人'),
          inputField({
            name: 'feishu-profile',
            label: 'lark-cli profile（或 bot 的 app id）',
            value: draft.profile,
            placeholder: 'dsh-bridge',
            hint: '这个桥用哪个飞书应用。填 lark-cli 的 profile 名，也可以直接填 bot 的 app id'
              + '（形如 cli_xxxxxxxxxxxxxxxx），profile 名默认就是 app id。'
              + '换它等于换一个 bot：入站连接会重建，「绑定的人」也会被清空'
              + '（open_id 按应用维度隔离，换应用后旧 id 不再有效），需要重新发一句话认领。'
              + '留空则回到配置文件里的默认值。',
            onChange: (value) => setDraft((prev) => ({ ...prev, profile: value })),
          }),
        ]),

        h('div', { style: style.card, key: 'bind' }, [
          h('div', { style: style.title, key: 't' }, '绑定的人'),
          inputField({
            name: 'feishu-user-id',
            label: '飞书 open_id',
            value: draft.userId,
            placeholder: 'ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            hint: '留空 = 解绑，下一个给机器人发消息的人会被自动认领。不知道自己的 open_id 也没关系 —— '
              + '直接给机器人发一句话，它就记住了，不用在这里填。',
            onChange: (value) => setDraft((prev) => ({ ...prev, userId: value })),
          }),
        ]),

        h('div', { style: style.card, key: 'persona' }, [
          h('div', { style: style.title, key: 't' }, '口吻人设'),
          textAreaField({
            name: 'feishu-persona',
            label: '飞书侧的说话口吻',
            rows: 7,
            value: draft.persona,
            placeholder: '例如：和用户一起工作的女高中生，说话轻松活泼、口语化',
            hint: '所有推给你的文案（开工报告、阶段总结、工作汇报、闲聊）都用这个口吻写。'
              + '留空则回到配置文件里的默认人设。改完点保存即刻生效。',
            onChange: (value) => setDraft((prev) => ({ ...prev, persona: value })),
          }),
        ]),

        h('div', { style: style.card, key: 'chat' }, [
          h('div', { style: style.title, key: 't' }, '闲聊模型'),
          h('p', { style: style.hint, key: 'h' }, '发 /chat 进入闲聊模式时用哪个模型；留空则沿用 dsh 的默认模型。'),
          inputField({
            name: 'feishu-chat-provider',
            label: 'provider',
            value: draft.chatProvider,
            placeholder: 'deepseek-official',
            onChange: (value) => setDraft((prev) => ({ ...prev, chatProvider: value })),
          }),
          inputField({
            name: 'feishu-chat-model',
            label: 'model',
            value: draft.chatModel,
            placeholder: 'deepseek-flash',
            onChange: (value) => setDraft((prev) => ({ ...prev, chatModel: value })),
          }),
        ]),

        h('div', { style: style.actions, key: 'ops' }, [
          h('button', {
            key: 'save',
            type: 'button',
            style: Object.assign({}, style.button, state.busy ? { opacity: 0.6, cursor: 'default' } : {}),
            disabled: state.busy,
            onClick: save,
          }, state.busy ? '保存中…' : '保存'),
          state.error.length > 0 ? h('span', { style: style.error, key: 'e' }, state.error) : null,
          state.notice.length > 0 ? h('span', { style: style.notice, key: 'n' }, state.notice) : null,
        ]),
      ])
    }

    /** 注册进设置页的区块插槽。 */
    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'feishu-bridge',
        order: 100,
        label: () => '飞书桥',
        locale: NS,
      }, FeishuSection))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

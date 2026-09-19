/**
 * Browser half: the settings page where the operator ticks which compatibility
 * fixes are applied to outbound model requests.
 *
 * WHY A HAND-WRITTEN BUNDLE: `dsh-client-modules` serves a client half as a
 * prebuilt artifact executed through `window.__ModuleLoader__.load({ id, factory })`.
 * Writing that wrapper by hand keeps this package buildless in the same way as
 * the rest of the plugin.
 *
 * WHAT THE PAGE DOES: it renders one checkbox per fix, plus the host allowlist
 * and the diagnostic switch. The fix list is EMBEDDED at build time from the
 * Host's own catalog (`{"fixes":[{"id":"responses-reasoning-echo","title":"思考内容回传（Responses 协议）","hint":"命中 Responses 请求时，把该轮思考项补回 function_call 之前；上一轮响应捕获不到时，用历史里仍保留的思考文本合成。","detail":"第三方网关在 thinking 模式下要求随历史回传上一轮思考内容。DSH 在跨模型、跨适配器或压缩之后会丢掉思考签名，pi-ai 的 Responses 分支只回传带签名的思考项，于是带工具调用的续轮被网关以 400 拒绝。本修复只改写 /responses 请求，且在已有思考项时不动作。","defaultEnabled":false,"options":[{"id":"recentTurns","kind":"number","title":"只回放最近 N 轮思考","hint":"0 = 不限（当前行为）。长会话里注入量按窗口内降级轮数增长，每步重发；填 1 通常就够，能把它从约 1 MB 降到几 KB。","min":0},{"id":"singleReasoningSlot","kind":"boolean","title":"思考项只写一个文本槽","hint":"默认同时写 summary 与 reasoning_text（保险，但文本翻倍）。开启后合成项只写 reasoning_text，捕获到的原始项原样回放，注入文本约减半。"}]}],"defaults":{"enabled":[],"hosts":[],"diagnostics":false}}`), so the page and the Host enforce
 * one list and the browser needs no channel to the Host. Every tick is one field
 * write on the `llm-compat` namespace, so it applies to the model's next request
 * and survives a restart in the profile's `settings.yaml`.
 *
 * THREE FAILURE MODES THIS FILE IS BUILT TO SURVIVE, each already observed in
 * this plugin family:
 *
 * 1. `package.json`'s `dsh.client.inject` (PACKAGE names, ordering the module
 *    graph) and this module's `inject` export (SERVICE names, delaying activation
 *    until they exist) are not alternatives. Omitting a service that is read
 *    fails the load; omitting the whole export races and renders an inert page.
 * 2. A throw while the module is EVALUATED fails that plugin's load, so the
 *    factory body runs inside a try/catch that answers a no-op plugin.
 * 3. `host` is provided to a dynamic Client Package, not to a composition-loaded
 *    client bundle, so this file references only `React` and what `apply` receives.
 *
 * @module llm-for-dsh/client
 */
window.__ModuleLoader__.load({
  // Substituted with the package name at build time: the served module id IS the
  // package name, and two copies of one string drift.
  id: "llm-for-dsh",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    try {
      // `require` resolves through the page's module table; the package's
      // `dsh.client.inject` has already ordered these ahead of this bundle.
      const React = require('react')
      require('@deepseek-ai/dsh-client-ui-settings')

      /**
       * The fix catalog and defaults, embedded by the build from `src/fixes/` —
       * the same source the Host enforces. Shape:
       * `{ fixes: [{ id, title, hint, detail, defaultEnabled }], defaults: { enabled, hosts, diagnostics } }`.
       */
      const CATALOG = {"fixes":[{"id":"responses-reasoning-echo","title":"思考内容回传（Responses 协议）","hint":"命中 Responses 请求时，把该轮思考项补回 function_call 之前；上一轮响应捕获不到时，用历史里仍保留的思考文本合成。","detail":"第三方网关在 thinking 模式下要求随历史回传上一轮思考内容。DSH 在跨模型、跨适配器或压缩之后会丢掉思考签名，pi-ai 的 Responses 分支只回传带签名的思考项，于是带工具调用的续轮被网关以 400 拒绝。本修复只改写 /responses 请求，且在已有思考项时不动作。","defaultEnabled":false,"options":[{"id":"recentTurns","kind":"number","title":"只回放最近 N 轮思考","hint":"0 = 不限（当前行为）。长会话里注入量按窗口内降级轮数增长，每步重发；填 1 通常就够，能把它从约 1 MB 降到几 KB。","min":0},{"id":"singleReasoningSlot","kind":"boolean","title":"思考项只写一个文本槽","hint":"默认同时写 summary 与 reasoning_text（保险，但文本翻倍）。开启后合成项只写 reasoning_text，捕获到的原始项原样回放，注入文本约减半。"}]}],"defaults":{"enabled":[],"hosts":[],"diagnostics":false}}

      /** This bundle's build id; a stale page can otherwise make a fixed bug look present. */
      const BUILD = "c20c65905f88"

      /** Settings namespace, shared with the Host half. */
      const NAMESPACE = 'llm-compat'

      /**
       * Service names this page reads. The package names that order the module
       * graph live in `package.json`; this list is what makes activation wait for
       * the settings domain.
       */
      const inject = ['slots', 'settingsScope']

      /** One plain status card, used for every degraded state. */
      const message = (text) =>
        React.createElement('div', { className: 'llm-compat-page' }, React.createElement('p', { className: 'llm-compat-status' }, text))

      /** A snapshot-only scope for a page whose settings service is unavailable. */
      const inertScope = (reason) => {
        const snapshot = { status: 'unavailable', value: undefined, revision: undefined, writable: false, mode: 'inert' }
        return {
          getSnapshot: () => snapshot,
          subscribe: () => () => {},
          set: () => Promise.reject(new Error(reason)),
          unset: () => Promise.reject(new Error(reason)),
          mutate: () => Promise.reject(new Error(reason)),
        }
      }

      /**
       * Read one client service WITHOUT declaring it.
       *
       * `ctx.get(name)` is the optional-read form; the direct `ctx.<name>` form is
       * the one the Guard rejects for an undeclared service. Every call site goes
       * through this helper so this plugin has no service declaration to get wrong.
       *
       * @param ctx - client root context.
       * @param name - service key.
       * @returns the service, or undefined when this page does not expose it.
       */
      const service = (ctx, name) => {
        try {
          return ctx.get(name)
        } catch {
          return undefined
        }
      }

      /**
       * Narrow the namespace section into the value this page renders.
       *
       * Supplying a decoder is what keeps the controls ENABLED: without one the
       * scope validates the section against the schema it received over the wire
       * and reports `undefined` when that fails, leaving every control disabled
       * with no error shown. Decoding here is tolerant on purpose.
       *
       * @param section - the wire section for the `llm-compat` namespace.
       * @returns the value the page reads.
       */
      function decodeSection(section) {
        const fallback = {
          enabled: [...CATALOG.defaults.enabled],
          hosts: [...CATALOG.defaults.hosts],
          diagnostics: CATALOG.defaults.diagnostics === true,
          recentTurns: 0,
          singleReasoningSlot: false,
        }
        if (section === null || typeof section !== 'object' || Array.isArray(section)) return fallback
        const known = new Set(CATALOG.fixes.map((fix) => fix.id))
        return {
          enabled: Array.isArray(section.enabled)
            ? section.enabled.filter((id) => typeof id === 'string' && known.has(id))
            : [...CATALOG.defaults.enabled],
          hosts: Array.isArray(section.hosts)
            ? section.hosts.filter((host) => typeof host === 'string' && host.trim().length > 0)
            : [...CATALOG.defaults.hosts],
          diagnostics: section.diagnostics === true,
          recentTurns: Number.isInteger(section.recentTurns) && section.recentTurns > 0 ? section.recentTurns : 0,
          singleReasoningSlot: section.singleReasoningSlot === true,
        }
      }

      /**
       * Insert the page stylesheet.
       *
       * `styles` is a builtin of the DYNAMIC client evaluator; a bundle loaded
       * from a composition does not receive it. So it is used when present and
       * otherwise the tag is inserted directly, which is self-contained.
       *
       * @returns a disposer removing the tag.
       */
      function insertStyles() {
        const owner = typeof styles === 'undefined' ? undefined : styles
        if (owner !== undefined && typeof owner.insert === 'function') return owner.insert(CSS)
        const document = globalThis.document
        if (document === undefined || document.head === undefined) return () => {}
        const tagId = "llm-for-dsh" + '/settings.css'
        const existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']')
        if (existing !== null) return () => existing.remove()
        const tag = document.createElement('style')
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }

      /**
       * Subscribe a component to a scope snapshot.
       * @param scope - the bound namespace scope.
       * @returns the current snapshot, re-rendered after every accepted change.
       */
      function useScopeSnapshot(scope) {
        const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot())
        React.useEffect(() => {
          const sync = () => setSnapshot(scope.getSnapshot())
          sync()
          return scope.subscribe(sync)
        }, [])
        return snapshot
      }

      /** Explain why writes are unavailable, in the page's own status line. */
      function describeUnavailable(snapshot) {
        if (snapshot.mode === 'memory') return '当前页面不以本机模式连接 Host，改动不会持久化。'
        return 'Host 未暴露 llm-compat 命名空间，或读取尚未完成。'
      }

      /** Parse the host field: one hostname per line or comma. */
      function parseHosts(text) {
        return String(text)
          .split(/[\s,]+/)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      }

      /** Render the fix checkboxes and the two document-level switches. */
      function CompatSettingsPage(props) {
        const scope = props.scope
        const snapshot = useScopeSnapshot(scope)
        /** The user's latest choices, so a control reflects a click immediately. */
        const [draft, setDraft] = React.useState(null)
        /** The last write failure, so a refusal is visible instead of silent. */
        const [writeError, setWriteError] = React.useState(null)
        /** The host field is edited as TEXT and written on blur: one write per keystroke would queue a mutation for every character. */
        const [hostsDraft, setHostsDraft] = React.useState(null)
        /** Number options are edited as text and written on blur, for the same reason. */
        const [numericDraft, setNumericDraft] = React.useState({})

        const stored = decodeSection(snapshot.value)
        const value = draft ?? stored
        const editable = snapshot.mode !== 'inert'

        const commit = (field, next) => {
          if (!editable) return
          setWriteError(null)
          Promise.resolve()
            .then(() => scope.set(field, next))
            .catch((error) => {
              setDraft(null)
              setWriteError(error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error))
            })
        }

        const toggleFix = (id) => {
          const next = new Set(value.enabled)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          const list = CATALOG.fixes.map((fix) => fix.id).filter((candidate) => next.has(candidate))
          setDraft({ ...value, enabled: list })
          commit('enabled', list)
        }

        const toggleDiagnostics = () => {
          const next = value.diagnostics !== true
          setDraft({ ...value, diagnostics: next })
          commit('diagnostics', next)
        }

        /**
         * Write one number option, clamped to its minimum; an unparsable entry
         * falls back to 0 (which means "no bound" for the options that have one).
         */
        const commitNumber = (option, current) => {
          const raw = numericDraft[option.id]
          if (raw === undefined) return
          setNumericDraft({ ...numericDraft, [option.id]: undefined })
          const parsed = Number.parseInt(String(raw), 10)
          const next = Number.isInteger(parsed) && parsed > 0 ? parsed : 0
          if (next === current) return
          setDraft({ ...value, [option.id]: next })
          commit(option.id, next)
        }

        /**
         * One control for one declared fix option.
         *
         * The copy comes from the fix's own `options` entry in the embedded
         * catalog, so a new option is one declaration in the fix and nothing here.
         */
        const optionRow = (option) => {
          const current = value[option.id]
          if (option.kind === 'number') {
            return React.createElement(
              'div',
              { className: 'llm-compat-subrow', key: option.id },
              React.createElement(
                'span',
                { className: 'llm-compat-body' },
                React.createElement('span', { className: 'llm-compat-name' }, option.title),
                React.createElement('span', { className: 'llm-compat-hint' }, option.hint),
              ),
              React.createElement('input', {
                type: 'number',
                min: option.min ?? 0,
                step: 1,
                className: 'llm-compat-number',
                disabled: !editable,
                value: numericDraft[option.id] ?? String(current ?? 0),
                onChange: (event) => setNumericDraft({ ...numericDraft, [option.id]: event.target.value }),
                onBlur: () => commitNumber(option, current),
              }),
            )
          }
          return React.createElement(
            'label',
            { className: 'llm-compat-subrow', key: option.id },
            React.createElement('input', {
              type: 'checkbox',
              className: 'llm-compat-check',
              checked: current === true,
              disabled: !editable,
              onChange: () => {
                const next = current !== true
                setDraft({ ...value, [option.id]: next })
                commit(option.id, next)
              },
            }),
            React.createElement(
              'span',
              { className: 'llm-compat-body' },
              React.createElement('span', { className: 'llm-compat-name' }, option.title),
              React.createElement('span', { className: 'llm-compat-hint' }, option.hint),
            ),
          )
        }

        const commitHosts = () => {
          if (hostsDraft === null) return
          const list = parseHosts(hostsDraft)
          setHostsDraft(null)
          if (list.join('\n') === value.hosts.join('\n')) return
          setDraft({ ...value, hosts: list })
          commit('hosts', list)
        }

        return React.createElement(
          'div',
          { className: 'llm-compat-page' },
          React.createElement('h2', { className: 'llm-compat-title' }, 'LLM 兼容性修复'),
          React.createElement(
            'p',
            { className: 'llm-compat-lead' },
            '这里逐项控制插件对「发往模型的请求体」所做的兼容改写。每项互相独立：选中即启用，取消即完全恢复原生请求，且无需重启。',
          ),
          CATALOG.fixes.map((fix) =>
            React.createElement(
              'section',
              { className: 'llm-compat-card', key: fix.id },
              React.createElement(
                'label',
                { className: 'llm-compat-row' },
                React.createElement('input', {
                  type: 'checkbox',
                  className: 'llm-compat-check',
                  checked: value.enabled.indexOf(fix.id) !== -1,
                  disabled: !editable,
                  onChange: () => toggleFix(fix.id),
                }),
                React.createElement(
                  'span',
                  { className: 'llm-compat-body' },
                  React.createElement('span', { className: 'llm-compat-name' }, fix.title),
                  React.createElement('span', { className: 'llm-compat-hint' }, fix.hint),
                  React.createElement('span', { className: 'llm-compat-detail' }, fix.detail),
                ),
              ),
              (fix.options ?? []).map(optionRow),
            ),
          ),
          React.createElement(
            'section',
            { className: 'llm-compat-card' },
            React.createElement('span', { className: 'llm-compat-name' }, '生效主机范围'),
            React.createElement(
              'span',
              { className: 'llm-compat-hint' },
              '只对列出的主机改写请求，每行一个（可写域名或 URL）。留空表示所有主机——混用官方直连路由时建议填入中继域名。',
            ),
            React.createElement('textarea', {
              className: 'llm-compat-hosts',
              rows: 3,
              spellCheck: false,
              disabled: !editable,
              value: hostsDraft ?? value.hosts.join('\n'),
              placeholder: 'relay.example',
              onChange: (event) => setHostsDraft(event.target.value),
              onBlur: commitHosts,
            }),
          ),
          React.createElement(
            'section',
            { className: 'llm-compat-card' },
            React.createElement(
              'label',
              { className: 'llm-compat-row' },
              React.createElement('input', {
                type: 'checkbox',
                className: 'llm-compat-check',
                checked: value.diagnostics === true,
                disabled: !editable,
                onChange: toggleDiagnostics,
              }),
              React.createElement(
                'span',
                { className: 'llm-compat-body' },
                React.createElement('span', { className: 'llm-compat-name' }, '诊断日志'),
                React.createElement('span', { className: 'llm-compat-hint' }, '把每次改写和捕获写进 Host 的 llm-compat.log，用于核对网关到底收到了什么。'),
              ),
            ),
          ),
          writeError === null ? null : React.createElement('p', { className: 'llm-compat-error' }, '写入被拒绝：' + writeError),
          React.createElement(
            'p',
            { className: 'llm-compat-status' },
            '页面版本 ' + BUILD + ' · ' + (editable ? '改动会持久化到 Profile 的 settings.yaml' : describeUnavailable(snapshot)),
          ),
        )
      }

      /** Contain a render failure to this page instead of the settings shell. */
      class Boundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }

        static getDerivedStateFromError(error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }

        render() {
          if (this.state.error !== null) {
            return message('LLM 兼容性修复页渲染失败（插件内部错误，不影响模型请求）：' + this.state.error)
          }
          return this.props.children
        }
      }

      /**
       * Register the settings page.
       * @param ctx - client root context.
       */
      function apply(ctx) {
        ctx.effect(() => insertStyles(), 'llm-compat: settings styles')

        // Declared in `inject`, so this resolves before apply runs; the lookup and
        // the inert fallback are kept as a net, and reaching one means the
        // declaration and the runtime disagree.
        const binder = service(ctx, 'settingsScope')
        const scope =
          binder !== undefined && typeof binder.bind === 'function'
            ? binder.bind({ namespace: NAMESPACE, decode: decodeSection })
            : inertScope('设置服务未挂载（settingsScope 服务缺失），页面只能显示当前状态。')

        const slots = service(ctx, 'slots')
        if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          // No slot ledger on this page: there is nothing to attach to, and
          // nothing that should fail this plugin's load over it.
          return
        }
        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: 'llm-compat', order: 31, label: () => 'LLM 兼容性修复' },
            () => React.createElement(Boundary, null, React.createElement(CompatSettingsPage, { scope })),
          ),
        )
      }

      /* @llm-compat-css-begin */
      /** Page stylesheet; theme tokens only, so light and dark both come out right. */
      const CSS = [
        '.llm-compat-page{display:flex;flex-direction:column;gap:16px;width:100%;max-width:860px;color:var(--dsw-alias-label-primary)}',
        '.llm-compat-title{margin:0;font-size:15px;font-weight:600;line-height:22px}',
        '.llm-compat-lead{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
        '.llm-compat-status{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
        '.llm-compat-error{margin:0;color:var(--dsw-alias-state-warn-primary);font-size:12.5px;line-height:19px}',
        '.llm-compat-card{display:flex;flex-direction:column;gap:10px;padding:14px 16px 16px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:12px}',
        '.llm-compat-row{display:flex;align-items:flex-start;gap:10px;min-height:32px;cursor:pointer}',
        '.llm-compat-check{margin-top:3px;flex:none}',
        '.llm-compat-body{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto}',
        '.llm-compat-name{font-size:14px;font-weight:600;line-height:20px}',
        '.llm-compat-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:19px}',
        '.llm-compat-detail{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
        '.llm-compat-subrow{display:flex;align-items:flex-start;gap:10px;margin-left:26px;padding-top:8px;border-top:.5px dashed var(--dsw-alias-border-l1);cursor:pointer}',
        '.llm-compat-number{width:88px;flex:none;padding:6px 8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;font:inherit;font-size:12.5px}',
        '.llm-compat-hosts{width:100%;box-sizing:border-box;padding:8px 10px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;font:inherit;font-size:12.5px;line-height:18px;resize:vertical}',
      ].join('')
      /* @llm-compat-css-end */

      exports.inject = inject
      exports.apply = apply
      exports.decodeSection = decodeSection
      exports.message = message
    } catch (error) {
      /*
       * A throw while this module is being evaluated fails this plugin's load.
       * Answering a no-op plugin keeps a mistake in this file from taking the
       * loader down with it; the Host half keeps working either way.
       */
      module.exports.apply = () => {}
      module.exports.inject = []
      module.exports.loadError = error instanceof Error ? error.message : String(error)
    }

    return module.exports
  },
})

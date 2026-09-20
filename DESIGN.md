# 设计

## 现象与根因

第三方网关（例：某中继的 `api: openai-responses` 路由）在 thinking 模式下要求把上一轮的思考内容随历史回传。请求里一旦有 `function_call` 而没有对应的 reasoning item，网关就以 400 拒绝，报错原文点名 `reasoning_text`。

思考项是在客户端丢的，链路如下：

1. harness 的 assistant 历史带着 `source.replayState`（适配器私有的重放元数据）。`dsh-llm` 只在「历史 provider 与目标 provider 由同一个适配器实例拥有」时才把它交给目标适配器；跨适配器（官方直连 `dsh-llm-deepseek` ↔ pi-ai 中转）或压缩改写之后，重放状态被剥掉。
2. 剥掉之后 `dsh-llm-pi-ai` 走 `foreignAssistant()`：把 harness 的 `reasoning` 块降级成**没有 `thinkingSignature` 的 thinking 块**，并把 `api` 标成 `dsh-foreign`。
3. `@earendil-works/pi-ai` 的 Responses 请求构造只回传**有签名**的思考项（`if (block.thinkingSignature) output.push(JSON.parse(...))`）。没有签名就整条丢掉。
4. pi-ai 只对 chat-completions 的 DeepSeek 分支补了 `reasoning_content: ""`，Responses 分支没有等价补丁；而 DSH 现成的 `compat.requiresReasoningContentOnAssistantMessages` 开关同样只作用于 chat-completions 的 `reasoning_content`，覆盖不到 Responses 的思考项。

于是：带工具调用的续轮缺少 reasoning item → 400。

## 两个扩展点

### 1. 只读观察点：`llm/stream`

`llm/stream` 是官方的 waterfall 事件。LOOP 组装的请求到达监听器时**已经深度冻结**：它的内容是会话日志的纯函数（可重建性不变量），契约明确要求监听器「读，不写」。本插件严格只读：

- 收集每条 assistant 消息里的 `reasoning` 文本；
- 收集它产生的 `tool-call` id；
- 若该消息的 `source.replayState` 仍是可用的 v2 信封，顺带取出原始 provider 签名。

结果按 `call_id` 索引进进程内的旁路表（`src/stash.js`）。

### 2. 出口改写点：`globalThis.fetch`

harness 的请求 seam 不能被改写，但**线格式**是在适配器内部（pi-ai）产生的，而进程里所有提供方栈最终都落到 `globalThis.fetch`：OpenAI 的 `new OpenAI({ fetch: options?.fetch })` 在没有显式 fetch 时取的就是全局那个，Anthropic 侧同理。包一层 `fetch` 因此是能看见最终 body 的最窄位置。

拦截器对每一次请求执行同一套判定，任一环节不满足就原样透传：

1. 方法是 `POST`；
2. body 是可读的 JSON 字符串（`init.body` 字符串，或从 `input.clone()` 读到）；
3. 至少有一个修复项被勾选；
4. 主机在允许列表内（空列表表示所有主机）；
5. 某个修复项的 `requestMatcher(url, body)` 返回 true。

任一步抛错、任何解析失败、任何修复项异常，都会让**原始请求**发出去——这个包装器永远不会成为模型调用失败的原因。

## 修复契约

`src/fixes/index.js` 是目录（唯一事实来源）；`src/fixes/<id>.js` 是实现。一项修复声明：

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定标识，存进设置文档 |
| `title` / `hint` / `detail` | 设置页文案 |
| `defaultEnabled` | 无用户分节时的默认值 |
| `requestMatcher(url, body)` | 这条请求是否归它管 |
| `rewrite(body, context)` | 就地改写已解析的 body，返回改动计数；`context.stash` 是旁路索引 |
| `observes(url)` / `createResponseObserver()` | 可选：捕获流式响应，供下次请求逐字节回传 |

框架不认识任何具体 id：加一项是「一个文件 + 目录一行」，删一项是「删文件删行」。UI 与 Host 读同一份目录——构建期把目录序列化进浏览器产物（`__LLM_COMPAT_CATALOG__`），所以页面不会给出 Host 不认的开关。

## 首个修复：`responses-reasoning-echo`

只认 `POST` 到 `*\/responses` 且 `input` 是数组的请求，然后：

- 逐项扫描 `input`；把 `reasoning` 记作「本轮已有思考」；
- 遇到 `function_call` / `custom_tool_call` 而本轮尚无思考项时，用 `call_id` 查旁路；
- 命中则在该 item **之前**插入思考项，本轮只插一次（一个思考项覆盖该轮所有并行工具调用）；
- 边界是「既不是本轮思考、也不是 assistant message、也不是工具调用」的 item——实践中就是用户消息与 `function_call_output`——遇到边界即重置，因此下一轮会拿到它自己的思考项；
- 已有思考项时不动，重复执行也不再改动（幂等）。

思考项的来源与优先级：

1. **捕获项（最高保真）**：从上一轮流式响应里原样留下的 reasoning item（`response.output_item.done`，缺失时回落到终态 `response.completed.response.output`），按该轮 `call_id` 索引；
2. **历史文本**：harness 里仍然持久保留的思考文本，合成一个最小 item（`summary` 与 `content` 两个槽都填，因为报错点名的是 `reasoning_text`，而 UI 语义读的是 summary），**不伪造 `id`**；
3. 两者都没有则完全不动作——宁可不改，也不凭空造一个空思考项，那更容易被校验配对的网关拒绝。

## 修复选项

修复可以声明自己读的选项：条目里的 `options` 描述控件（`kind`、标题、说明、最小值），设置页据此通用渲染，Host 侧由 `normalizeSettings` 折叠成安全值后交给 `rewrite(body, context)`。当前唯一的修复声明两项，二者正交、可同时开启：

| 选项 | 取值 | 作用 | 默认 |
| --- | --- | --- | --- |
| `recentTurns` | 非负整数，`0` = 每一轮 | 缺项轮一律补齐（网关校验整个窗口）；这个值只决定哪几轮用**真实**思考文本。更早的缺项轮退化为占位项，因此覆盖面与成本解耦 | `0` |
| `singleReasoningSlot` | 布尔 | 合成项只写 `content: [{ type: "reasoning_text" }]` 一个槽，省掉 summary 里的重复副本；捕获到的原始项则完全按网关发来的形状回放，不再补槽 | `false` |
| `placeholderReasoning` | 布尔 | 允许在没有可回放内容时补文本为单个空格的思考项。它同时是「最近 N 轮」之外那些轮次的补齐手段：缺了它，`recentTurns > 0` 就只能覆盖最新 N 轮。空格而非空串，是因为会 trim 或拒空的分支仍然接受空白 | `false` |

两个默认值都保持「已验证可用」的行为：不改设置时插件的行为与调参前一致。

## 与页面的通道

设置页只通过两条路与 Host 交互：设置命名空间（开关本身）和**一条同源路由** `/llm-compat/log`。修复目录是构建期嵌进浏览器产物的，所以页面不需要任何运行时通道来画自己；只有「日志文件在哪里」和「清空它们」必须由 Host 回答。路由注册在可选的 `webServer` 服务上：没有它就只显示路径提示，不影响插件加载。

## 数据流

```
会话日志 → dsh-agent-loop → llm/stream（本插件只读）
                                 │  call_id → 思考文本 / 原始签名
                                 ▼
                             stash（进程内，LRU + TTL）
                                 ▲
                                 │  流式响应里捕获到的 reasoning item
pi-ai 适配器 → 组装线格式 body → globalThis.fetch（本插件改写）→ 网关
                                 ▲
                                 └── 命中修复项时，在 function_call 前插入思考项
```

旁路以 `call_id` 为键。工具调用 id 由提供方铸造且唯一，因此一个进程级映射也不会让并发会话或子代理串台。pi-ai 把工具调用编码成 `<call id>|<item id>`，索引两侧统一取竖线之前的那半。

## 失败与降级

| 情况 | 行为 |
| --- | --- |
| 修复项抛错 | 记录（诊断开启时）并原样透传该请求 |
| body 不是 JSON / 形状不符 | 原样透传 |
| 主机不在允许列表 | 不读取 body，原样透传 |
| 没有可用的思考内容 | 不改写 |
| 设置文档畸形 | 折叠回默认值，插件不因配置而停摆 |
| 插件激活抛错 | 记录并以「无修复」状态继续，绝不让加载器带着整个 profile 崩掉 |
| 诊断日志写入失败 | 静默忽略；诊断不能反过来弄坏模型调用 |

## 跨平台

Host 半是纯 ESM + Node 内置模块；路径一律用 `node:path` 组件拼接，构建产物里的文件列表统一用 `/` 归一化，因此同一份源码在 Windows、macOS、Linux 上构建出逐字节相同的结果。浏览器半是手写的客户端模块 bundle，只用 React 与设置底座提供的服务。

## 与官方修复的关系

一旦 `dsh-llm-pi-ai`／pi-ai 自身在签名缺失时也能回传思考项，本插件即可整包删除：它不改 harness 任何文件，卸载后行为与装前一致。这正是把修复做成「可勾选、可卸载列表」而不是直接改上游的原因。

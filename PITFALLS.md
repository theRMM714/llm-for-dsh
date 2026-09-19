# 踩坑与当前处理

本文件只记录**当前仍然成立**的约束，以及代码为绕开它们所做的选择。

## 1. `llm/stream` 的请求是冻结的，不能改写

LOOP 组装的请求到达 waterfall 监听器时已深度冻结（改写会抛），因为它的内容是会话日志的纯函数（可重建性不变量）。插件的观察者因此严格只读，真正的改写发生在 `globalThis.fetch`——线格式所在的层。见 [DESIGN.md](DESIGN.md)。

## 2. 提供方 SDK 在构造客户端时取用全局 fetch

`openai` 的客户端构造函数执行 `this.fetch = options.fetch ?? getDefaultFetch()`，而 `getDefaultFetch()` 取当时的全局 `fetch`；pi-ai 每次请求都新建客户端，所以插件在激活时安装拦截器即可覆盖后续请求。**在安装之前就已构造好的客户端不会被拦截**——这是唯一的时间窗，正常加载顺序下不会踩到（插件在所有模型调用之前激活）。

## 3. `content-length` 会让改写后的请求被拒

body 变长之后必须丢掉调用方可能自带的 `content-length`（否则 undici 与服务端的长度校验会打架）。拦截器用 `Headers` 拷贝一份并 `delete('content-length')`，其余请求头（含鉴权）原样保留。

## 4. 响应克隆必须在读取之前，而且必须被消费

捕获用 `response.clone()`，且必须在调用方读取 body 之前克隆，否则抛错。另一个分支必须真的读走（`reader.read()` 直到结束并在 `finally` 里 `cancel`），否则数据会堆在克隆分支里。观察失败被完全吞掉：捕获只是加成，不能影响正在进行的模型调用。

## 5. 工具调用 id 是复合的

pi-ai 把工具调用编码成 `<call id>|<item id>`（item id 在跨模型时会被丢弃，因为在 Responses 协议里 `fc_*` 与 `rs_*` 的配对校验会拒绝它），而线格式里的 `call_id` 是竖线之前的那半。索引两侧统一归约，否则同一次调用在两侧对不上。

## 6. 不要凭空造 reasoning item 的 id

reasoning item 的 `id` 由提供方铸造。伪造一个比留空更容易被网关拒绝，因此合成项只带 `summary` 与 `content` 文本槽，不带 `id`；能用响应捕获到的原始 item 时优先逐字节回传。

## 7. schema 默认值必须写在 schema 里

命名空间没有存储分节时，字段默认值是经 schema 解析出来的；把默认值只写在 composition `base` 里，会让全新安装上这个开关「看起来存在、实际为空」。因此 `Config` 自己带 `default`，`normalizeSettings` 只做折叠与丢弃未知 id。

## 8. 浏览器半有两个互不等价的服务声明

`package.json` 的 `dsh.client.inject` 是**包名**，决定模块图顺序；模块导出的 `inject` 是**服务名**，决定激活时机。少写服务名会以 `cannot get property "slots" without inject` 直接失败；整段省略会竞态到一个惰性 scope，页面渲染出全部禁用的控件。另外，求值期抛错会让该插件的加载失败，所以工厂函数体整体包在 try/catch 里，答一个空操作插件。

## 9. `host` 不在 composition 加载的客户端 bundle 作用域里

`host` 只提供给动态客户端包。本插件的浏览器半只引用 `React` 与 `apply` 收到的东西，样式表由 bundle 自己插入（`styles` 内建存在时优先用它）。

## 10. 受限沙箱拒绝派生带管道的子进程

`node --test` 默认按文件隔离，会为每个测试文件派生带管道的子进程，在受限沙箱里以 `spawn EPERM` 失败。测试脚本因此使用 `--test-isolation=none`。这不是绕过沙箱：本套件没有依赖文件级隔离的全局状态。

## 11. harness 包无法从 manifest 安装

`@deepseek-ai/schemastery` 等随 `@deepseek-ai/dsh` 嵌套发布，不在公共 registry 上，因此全部列为可选 peer，测试所需的极少数由 `scripts/link-dev-deps.mjs` 在本地建目录链接（`node_modules/` 已忽略）。测试同时检查「从 PATH 与 npm prefix 定位 harness」的候选路径，避免依赖某个具体机器的布局。

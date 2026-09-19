# 测试

## 运行

```sh
npm test        # node --test，含 pretest 的依赖链接
npm run check   # lib/ 是否与 src/ 的新构建一致
npm run build   # 重新生成 lib/
```

`npm test` 使用 `--test-isolation=none`，也就是全部测试文件在同一个进程内运行。原因见 [PITFALLS.md](PITFALLS.md)：默认的按文件隔离会为每个文件派生带管道的子进程，在受限沙箱里会被拒绝；本套件内部没有需要文件级隔离的全局状态（唯一会改全局的集成测试在 `finally` 里还原 `globalThis.fetch`）。

测试导入的是 `src/`；`lib/` 是否最新由 `test/lib-current.test.mjs` 逐字节比对，因此「提交了过期的产物」会直接让测试失败。

## 开发依赖

Host 半与测试用到的 `@deepseek-ai/schemastery` 随 `@deepseek-ai/dsh` 嵌套发布，不在公共 registry 上，无法从 manifest 安装。`scripts/link-dev-deps.mjs` 在 `node_modules/@deepseek-ai/` 下为它建一个指向已安装 harness 的目录链接（Windows 用 junction），`pretest` 会自动运行。

找不到 harness 时显式指定一次：

```sh
node scripts/link-dev-deps.mjs /path/to/@deepseek-ai/dsh
```

`node_modules/` 被忽略，链接不会入库。

## 覆盖面

| 文件 | 覆盖 | 类型 |
| --- | --- | --- |
| `test/fix-responses.test.mjs` | 端点匹配、插入位置与幂等、并行工具调用每轮只插一次、轮次边界重置、捕获项优先且为克隆、合成项形状与不伪造 id、响应观察者（逐项事件与终态回落、异常事件容忍） | 单元 |
| `test/stash.test.mjs` | 复合 call id 归约、记录／查找、空载荷不入库、TTL 过期、容量淘汰、harness 提取（文本 + call id + 重放签名）、畸形输入 | 单元 |
| `test/interceptor.test.mjs` | 关闭时不改一个字节、方法／body 形状闸门、主机闸门与域名归一化、命中改写、未知 id 忽略、修复项抛错被包含、SSE 解析（流在缺少结束空行时仍交付最后一条事件、非事件流不捕获）、目录默认关闭 | 单元 |
| `test/settings.test.mjs` | 空文档经 schema 取默认值、存储值保留、未知 id 丢弃、畸形分节回落、主机归一化 | 单元 |
| `test/host.test.mjs` | 命名空间注册（含 schema 与 `applies: 'live'`）、`llm/stream` 监听挂载、拦截器安装与卸载还原、观察失败不影响下游流、设置实时采用、无设置服务仍能激活 | 集成（假 ctx） |
| `test/integration.test.mjs` | 本地假网关：无拦截器时复刻 400；启用后历史文本路径修复并返回 200；捕获项路径逐字节回传 | 端到端（进程内 HTTP） |
| `test/client.test.mjs` | 浏览器半以 `__ModuleLoader__` 载入、注册名与服务声明、目录驱动的解码、设置页注册与渲染、缺设置服务／缺 slot 账本时的降级、求值期抛错降级为空操作 | 集成（假模块加载器） |
| `test/lib-current.test.mjs` | 包名一致、构建覆盖到修复目录、嵌入目录内容、`lib/` 与新建构逐字节一致、构建确定性 | 构建 |

## 尚未覆盖（如实记录）

- **真实网关的接受形状**：某个具体中继究竟接受什么形态的 reasoning item（是否必须带 `id`／`encrypted_content`、是否只认 `content:[{type:"reasoning_text"}]`）无法从代码推断，必须用真机确认。本地假网关复刻的是「缺少思考项即 400」这一条判定。
- **真实 harness 装载**：没有在 Profile 里端到端拉起插件行的自动化测试；`llm/stream` 观察者与拦截器是按接口契约用假 ctx 驱动的。
- **真实浏览器渲染**：设置页在假 React 下走通渲染路径，但没有 DOM／样式回归。

## 真机验收步骤

1. `npm run check && npm test` 全绿；
2. 装进 Profile，重启 dsh web，设置页出现「LLM 兼容性修复」；
3. 勾选 `responses-reasoning-echo`，在「生效主机范围」填入失败路由的主机（例：`relay.example`），打开诊断日志；
4. 在该路由上跑一次「思考 + 工具调用 → 续轮」：修复前稳定 400，勾选后应完成；
5. 检查 `$DSH_HOME/llm-compat.log`：每请求一行 `rewrote ... via responses-reasoning-echo(n)`，每响应一行 `resp <status> ...`；若出现 400，`llm-compat-rejected.jsonl` 会多出一条记录，内含状态、网关原文与**当次发出的完整请求体**（超过 256 KiB 截断并标注）。这是判断网关到底反对哪一项的唯一直接证据；
6. 取消勾选，确认同一会话回到 400，且 `llm-compat.log` 不再增长。

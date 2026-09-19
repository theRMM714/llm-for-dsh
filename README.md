# llm-for-dsh

一个 DeepSeek Harness 插件：**可插拔地修复发往模型的请求**，并在「设置 → LLM 兼容性修复」里逐项勾选启用。

首个（也是当前唯一的）修复项解决这个现象：

```
OpenAI API error (400): {"message":"The `reasoning_text` in the thinking mode must be passed back to the API.","type":"invalid_request_error"}
```

它发生在第三方网关的 Responses 路由上，通常紧跟在一次工具调用之后。根因与代码级证据见 [DESIGN.md](DESIGN.md)。

## 安装

本包自带补丁层（`dsh.bundle.patch`）：装包即挂载，不需要手改 profile 配置。

```sh
# 本地路径（开发时最省事：link 改完即生效）
dsh plugin --profile <profile> add /path/to/llm-for-dsh

# 从 GitHub（推荐；lib/ 已入库，因此不需要构建脚本，也就不需要 allowBuilds 放行）
dsh plugin --profile <profile> add github:theRMM714/llm-for-dsh
```

更新同为一条命令：`dsh plugin --profile <profile> update llm-for-dsh`。

> 从 GitHub 安装/更新时 shell 里要能访问 github.com；若网络需要代理，先 `export HTTPS_PROXY=http://127.0.0.1:<端口>`。

重启 Profile 后，设置面板出现「LLM 兼容性修复」页。

## 使用

设置页里有三组开关，全部即时生效并持久化到 Profile 的 `settings.yaml`：

| 控件 | 作用 |
| --- | --- |
| 每个修复项一个复选框 | 勾选即启用该项改写；取消即完全恢复原生请求 |
| 生效主机范围 | 只对这些主机改写（域名或 URL，每行一个）。留空表示所有主机——混用官方直连路由时建议填入中继域名，例如 `relay.example` |
| 诊断日志 | 把每次改写、捕获与响应状态写进 Host 的 `llm-compat.log`；请求被网关拒绝时，还会把**当时发出去的完整请求体**写进同目录的 `llm-compat-rejected.jsonl`，用于核对网关到底反对哪一项 |

写入命名空间 `llm-compat`；配置面只有三个字段：`enabled`（修复 id 列表）、`hosts`、`diagnostics`。

## 当前修复项

| id | 作用 | 默认 |
| --- | --- | --- |
| `responses-reasoning-echo` | 命中 `/responses` 请求时，把该轮思考项补回 `function_call` 之前；优先用上一轮响应里捕获到的原始 reasoning item，其次是 harness 历史里仍保留的思考文本 | 关闭 |

默认关闭是有意的：这是一个会改写报文的功能，应当由使用者在看清它做什么之后再打开。

## 恢复与回退

按代价从低到高，三条路都可逆且互不依赖：

1. **取消勾选** —— 该请求立刻回到逐字节原生的形态；
2. **`DSH_LLM_COMPAT_DISABLED=1`** —— 整个补丁行不加载，插件不激活，一个环境变量搞定；
3. **删除** —— 移除补丁行或卸载包即可；插件不写除 `llm-compat.log` 之外的任何文件，也不改任何 harness 文件。

## 添加或移除一个修复

修复项是插件的扩展单元，框架本身不认识任何一个修复的 id：

- **添加**：写 `src/fixes/<id>.js`，在 `src/fixes/index.js` 的目录里加一行，然后 `npm run build` 并补测试。
- **移除**：删掉文件与目录行，重新 `npm run build`；`enabled` 里残留的旧 id 会在读取时被丢弃，不需要迁移。

契约见 [DESIGN.md](DESIGN.md) 的「修复契约」。

## 已知限制

- 只处理 `POST` 且 body 是 JSON **字符串**的请求（OpenAI 与 Anthropic SDK 的形态）；不读流式上传体。
- 响应捕获是进程内的：Host 重启之后，重启前产生的历史只能走「历史思考文本合成」这条路，而不是逐字节原样回传。
- 合成出的 reasoning item 不带 `id`：id 由提供方铸造，伪造一个比留空更容易被网关拒绝。
- 修复的验收建立在真实网关上（见 [TESTING.md](TESTING.md)）；本地测试用的是复刻该网关判断的假服务器。

## 目录

```
cordis.patch.yml        补丁层：挂载 llm-compat 这一行
src/index.js            主机半：设置命名空间、llm/stream 观察者、出口拦截器
src/fixes/index.js      修复目录（唯一事实来源）
src/fixes/*.js          各修复项
src/interceptor.js      fetch 包装：形状识别、改写、安全透传
src/stash.js            call_id → 思考内容的旁路索引
src/log.js              诊断日志
src/client.js           浏览器半：设置页
scripts/build.mjs       src/ → lib/ 的构建（含目录嵌入）
scripts/link-dev-deps.mjs  仅供测试：把 harness 包链接进本仓
lib/                    提交的构建产物，安装即用
test/                   node:test 测试
```

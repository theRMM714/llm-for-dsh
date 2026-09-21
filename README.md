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

重启 Profile 后，设置面板出现「LLM 工具」页（页内标题为「LLM 兼容性修复」）。

## 使用

设置页里有三组开关，全部即时生效并持久化到 Profile 的 `settings.yaml`：

| 控件 | 作用 |
| --- | --- |
| 每个修复项一个复选框 | 勾选即启用该项改写；取消即完全恢复原生请求 |
| 生效主机范围 | 只对这些主机改写（域名或 URL，每行一个）。留空表示所有主机——混用官方直连路由时建议填入中继域名，例如 `relay.example` |
| 诊断日志 | 把每次改写、捕获与响应状态写进 Host 的 `llm-compat.log`；请求被网关拒绝时，还会把**当时发出去的完整请求体**（头部 + 尾部 + 逐项摘要）写进同目录的 `llm-compat-rejected.jsonl`，用于核对网关到底反对哪一项 |
| 最近 N 轮写真实思考文本 | `responses-reasoning-echo` 的选项。缺项轮**总会**被补上；这个值只决定哪几轮用真实文本。`0`（默认）＝每一轮都用真实文本；填 `1` 则只有最新一轮用真实文本，更早的缺项轮改用单空格占位项——覆盖面不变，注入量从约 1 MB 降到几 KB。需要同时开启「没有思考时补一个占位项」 |
| 思考项只写一个文本槽 | 同一修复项的选项。默认同时写 `summary` 与 `reasoning_text` 两个槽（保险，但文本翻倍）；开启后合成项只写 `reasoning_text`、捕获到的原始项原样回放，注入文本约减半 |
| 没有思考时补一个占位项 | 同一修复项的选项。某一轮**既没有可回放的捕获项、也没有历史思考文本**时（提供方只回传了裸工具调用），补一个文本为单个空格的思考项，只为满足「必须回传」的存在性检查；它同时是「最近 N 轮」之外那些轮次的补齐手段。默认关闭 |
| 重试 | 一张卡片：**错误类型复选框列表** + 「最多重试次数」。命中规则时把**同一个请求原样再发一次**（模型调用层的重试，不会重跑工具）。规则默认关闭，次数默认 2、上限 5 |
| 思考形状统一成最保守形式 | `responses-reasoning-echo` 的选项。两件事一起做：请求里**所有**思考项只保留 `reasoning_text` 内容槽（`summary` 文本搬进 `content`、`id` 保留），并且去掉请求参数 `reasoning` 里的 `summary`（只留 `effort`）。实测同一中继的两个上游对形状要求相反——一个要求回传 `reasoning_text`，另一个对 `summary` 报 `unknown field`——两处都清掉后两边都接受。默认关闭 |
| 清理日志 | 一个按钮：清空 `llm-compat.log` 与 `llm-compat-rejected.jsonl`，就地开始新的观察。页面通过同源路由 `/llm-compat/log` 完成，Host 未提供 webserver 服务时该卡片只显示提示 |

三个选项互相独立、**可以同时开启**：一个决定哪几轮写真实文本、一个决定每个注入项写几个槽、一个决定没有文本可回放时是否补占位项。

实测（中继的 Responses 路由）网关校验的是**整个窗口**，不是最新一轮：窗口里任何一轮带工具调用却没有思考项，整个请求就被拒。所以覆盖面由「缺项即补」保证，`recentTurns` 只用来控制成本。

写入命名空间 `llm-compat`；配置面字段：`enabled`（修复 id 列表）、`hosts`、`diagnostics`，以及上面三个选项。

## 重试

有些失败不是报文能修好的。实测（中继的 Responses 路由）：一次请求在改写后 `gaps 0`（259 项、80 个工具轮全部带思考项），同一份形状连过三次、第四次被拒——报文结构没有任何差异，属于网关侧的间歇行为。

所以插件提供的是**重试**，而不是更多形状修补：

- 规则目录在 `src/retries/`，与修复目录同构：加一条规则 = 一个文件 + 目录一行，设置页的复选框列表随之增加；
- 当前唯一规则 `reasoning-text-not-passed-back`：HTTP 400 **且**正文同时含 `reasoning_text` 与 `must be passed back`（两个短语都要有，所以无关的 400 不会被重试）；
- 重试是**模型调用层**的：失败发生在「工具结果回传后的续写请求」上，重发只是再问一次模型，工具不会重跑、副作用不会重复；
- 退避为 300ms、600ms…（按尝试次数线性），并带抖动；
- 与 DSH 自带的 `dsh-llm-retry` 可共存：那个重试的是「整步失败」且默认不含 `INVALID_REQUEST`，要改 profile 配置；这个只认这一条报文，配置全在插件里，通常在中继侧抽到坏路由时先一步化解。

被拒报文与重试都会写进诊断日志（`retrying <url> (attempt 1/2) after reasoning-text-not-passed-back`），因此事后能判断「是重试救回来的」还是「真的连续失败」。

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
src/log.js              诊断日志（读取路径、被拒报文落盘、清空）
src/retries/index.js    重试规则目录（唯一事实来源）
src/retries/*.js        各重试规则
src/limits.js           共享数值上限（重试次数等）
src/routes.js           Host 与客户端共用的路由常量
src/client.js           浏览器半：设置页
scripts/build.mjs       src/ → lib/ 的构建（含目录嵌入）
scripts/link-dev-deps.mjs  仅供测试：把 harness 包链接进本仓
lib/                    提交的构建产物，安装即用
test/                   node:test 测试
```

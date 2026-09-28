# llm-for-dsh 适配 DSH 0.1.7-rc.2 · 实施计划

> **本文件是阶段性工作账本，不是长期文档。** 全部阶段销账后应删除；长期状态由 README / DESIGN / PITFALLS 承载，历史由 git 承载。

当前 DSH：`0.1.7-rc.2`（包目录 mtime `2026-09-28T11:08:48Z`）
当前状态：插件被 `DSH_LLM_COMPAT_DISABLED=1` 禁用；本计划的目标是解除该禁用。

---

## 一、目标与验收标准

**目标**：去掉 `DSH_LLM_COMPAT_DISABLED` 后，插件能激活、设置页可用、勾选即时生效，`web boot` 不再报条目未激活。

| # | 验收项 | 判据 |
| --- | --- | --- |
| V1 | web boot 无未激活条目 | 页面不再出现 `Failed to load plugins / waiting for service` |
| V2 | 设置页出现且可交互 | 「LLM 工具」页渲染四项选项、修复与重试复选框、诊断开关、日志卡片 |
| V3 | 勾选即时生效 | 改动后**下一次模型请求**即生效，无需重启 |
| V4 | 配置持久化 | 重启 DSH 后勾选状态保留（经 profile 的 Cordis patch） |
| V5 | 构建一致 | `node scripts/build.mjs --check` 通过 |
| V6 | 测试全绿 | `npm test` 全部通过（见 §十 的临时目录要求） |
| V7 | 诊断日志恢复 | `$DSH_HOME/llm-compat.log` 恢复增长 |

---

## 二、根因（实证）

DSH 0.1.7-rc.2 更换了设置模型，插件建立在旧模型上，**两半同时失效**：

| 半 | 现象 | 原文 |
| --- | --- | --- |
| 宿主 | `TypeError: settings.register is not a function` | `at setup (llm-for-dsh/lib/index.js:158:28)` |
| 客户端 | 条目永久 pending，web boot 判定失败 | `llm-for-dsh: pending (waiting for service: settingsScope)` |

- `dsh-settings` 的方法集已变为 `configure / invalidate / prepareDocument / describe / update / replace / mutate / write / schema`，**`register` 不复存在**。
- `settingsScope` 在 0.1.7-rc.2 的全部约 290 个包中**零命中**。

---

## 三、新契约参考（实现依据）

| 用途 | 新写法 | 样板 |
| --- | --- | --- |
| 可编辑字段 | `z.boolean().default(false).volatile()` | `dsh-agent-default-model/lib/index.js:21-25` |
| 实时读值 | `config.<field>.get()` | `dsh-agent-default-model/lib/index.js:39-43` |
| 写入 | `ctx.get('configEditor').edit(ctx.fiber.entry, () => next)` | `dsh-agent-default-model/lib/index.js:53-65` |
| 关掉自动表单 | `ctx.inject(['settings'], c => c.effect(() => c.settings.configure({ auto: false }, ctx.fiber)))` | `dsh-client-ui-conversation/lib/index.js:23-25` |
| 客户端取表单 | `ctx.configForms.get('<条目id>')` → `ConfigFormController` | `dsh-client-ui-settings/lib/client.js:1305-1316` |
| 按宿主服务注册页面 | `ctx.configForms.whileServed(['<条目id>'], register)` | `dsh-client-ui-settings/lib/client.js:1317-1329` |

**模型差异**：设置不再是「插件自己的命名空间 + 独立文档」，而是**投影 Loader 配置**；表单按 **profile 条目 id**（`llm-compat`）寻址，写入经 `configEditor` 落到 profile 的 Cordis patch。

---

## 四、范围

**改**
- `src/index.js` — 宿主设置层
- `src/client.js` — 设置页的绑定层（**不动 UI 结构与样式**）
- `test/host.test.mjs`、`test/settings.test.mjs` — 假 ctx 与服务形态
- `scripts/build.mjs`、`README.md`、`DESIGN.md`、`PITFALLS.md` — 随阶段同步

**不改**
- `src/interceptor.js`、`src/fixes/*`、`src/retries/*`、`src/stash.js` — 拦截与改写逻辑与设置模型无关
- `git-for-dsh`（本计划只覆盖 llm-for-dsh，待届时单独规划）
- 设置页的界面结构、样式、文案组织（只改"数据从哪来、往哪写"）

**设计决定**：新增 `readConfig(config)` 作为**宽容读取器**，对每个字段先试 `.get()`、否则取裸值。这样 `normalizeSettings` 保持纯函数，现有测试传入裸对象仍然有效，迁移期两侧都能跑。

---

## 五、阶段划分与销账规则

| 阶段 | 内容 | 产出 | 状态 |
| --- | --- | --- | --- |
| 0 | 基线与准备 | 基线记录、本文件 | ☐ |
| 1 | 宿主半设置层适配 | `src/index.js` 改造 + 测试同步 | ✔ 已完成 |
| 2 | 客户端半迁移到 `configForms` | `src/client.js` 改造 | ☐ |
| 3 | 真机验收 | V1–V4、V7 实测 | ☐ |
| 4 | 缺陷清理 | §七 的 D1–D15 | ☐ |
| 5 | 文档同步与销账 | README/DESIGN/PITFALLS 定稿、删除本文件 | ☐ |

**销账规则**
1. 每个阶段结束时更新本表状态，并在 §七 对应条目上标记。
2. 一个阶段**先测试后销账**：`build --check` + `npm test` 必须通过，否则该阶段不得标记完成。
3. 阶段 3 的实测证据（报错原文、日志行、设置页状态）追加到 §六 的"证据"小节，而不是写进长期文档。
4. 发现的新问题不混入当前阶段：登记到 §七 末尾的"新增"区，另行排期。
5. 阶段 4 可拆成多次提交，但 D1–D15 必须逐条有结论（已修 / 不改并说明理由 / 转为长期项）。

---

## 六、阶段任务

### 阶段 0 · 基线与准备

- [ ] 记录基线：禁用状态、测试基线、日志停摆时间点
- [ ] 确认 `settings.register` 与 `settingsScope` 的消失范围（已完成，见 §二）
- [ ] 确认新契约写法（已完成，见 §三）

**基线数据**
- `dsh` 升级时间：`2026-09-28T11:08:48Z`
- 诊断日志最后写入：`2026-09-27T16:18`（`llm-compat.log` / `git-for-dsh.log`）
- 测试：96 项，全部通过（**需把 `TEMP`/`TMP` 指向工作区目录**，否则 `mkdtemp` 被沙箱拒绝，14 项假失败）

### 阶段 1 · 宿主半设置层

- [x] `Config` 九个字段全部加 `.volatile()`
- [x] 删除 `settings.register` / `scope.get()` / `scope.watch()` / `settings.update()` 调用链
- [x] 新增 `readConfig(config)` 宽容读取器（成员是引用时取 `.get()`，否则取裸值）
- [x] `normalizeSettings` 改为接受已解包的裸值
- [x] 新增 `ctx.inject(['settings'], … configure({ auto: false }) …)`
- [x] `inject` 顶层依赖从 `['settings','llm']` 收窄为 `['llm']`，无设置服务的 profile 仍激活
- [x] 拦截器的 `resolveSettings` 改为每次请求实时折叠，保住 V3
- [x] **额外发现**：日志路由改用 `ctx.inject(['webServer'], …)`（见 E1）
- [x] `test/host.test.mjs`、`test/settings.test.mjs` 同步
- [x] `node scripts/build.mjs` + `npm test` → **97/97 通过**

**阶段 1 证据**
- `build --check`：`lib/ is current`
- 真实启动 `dsh --profile web --port 0 --no-open`：`llm-compat: activation failed` 报错消失（残留报错属 `git-for-dsh`，阶段外）
- 激活硬指标：插件自注册的 `GET /llm-compat/log` 返回 `200` 与正确 JSON：
  `{"log":"…\\.dsh\\llm-compat.log","rejected":"…\\.dsh\\llm-compat-rejected.jsonl"}`

### 阶段 2 · 客户端半

- [ ] `inject` 改为 `['slots', 'configForms']`
- [ ] 删除 `service(ctx, 'settingsScope')` 与 `inertScope` 降级分支
- [ ] 改为 `ctx.configForms.get('llm-compat')`
- [ ] 页面注册包进 `ctx.configForms.whileServed(['llm-compat'], …)`
- [ ] 写入改走表单控制器的写队列
- [ ] 文案「持久化到 `settings.yaml`」→「持久化到 Profile 的 Cordis patch」
- [ ] `test/client.test.mjs` 同步
- [ ] `node scripts/build.mjs` + `npm test`

### 阶段 3 · 真机验收

- [ ] 移除 `DSH_LLM_COMPAT_DISABLED`，重启 `dsh web`
- [ ] V1：页面无未激活条目
- [ ] V2：设置页出现且可交互
- [ ] V3：勾选后下一次请求生效
- [ ] V4：重启后状态保留
- [ ] V7：`llm-compat.log` 恢复增长

**证据**：（阶段 3 完成后填写）

### 阶段 4 · 缺陷清理

见 §七。

### 阶段 5 · 文档同步与销账

- [ ] README「安装 / 使用 / 已知限制」按新模型重写
- [ ] DESIGN「与官方修复的关系」补入 0.1.7-rc.2 的契约核对结论
- [ ] PITFALLS 编号归一、去掉观察过程叙事
- [ ] 全部阶段销账后删除本文件

---

## 七、缺陷清单

状态：`待处理` / `进行中` / `已修` / `不改（附理由）`

### A 组 · 设置模型适配（本计划主线）

| # | 位置 | 问题 | 状态 |
| --- | --- | --- | --- |
| A1 | `src/index.js` 设置层 | `settings.register` 已不存在，宿主半激活即抛错 | ✔ 已修（阶段 1） |
| A2 | `src/client.js:67` | `inject` 依赖已消失的 `settingsScope`，页面 entry 永久 pending | 待处理 |

### B 组 · 与官方 schema 的形状不一致

| # | 位置 | 问题 | 状态 |
| --- | --- | --- | --- |
| D1 | `src/fixes/responses-reasoning-echo.js:138-146` | 合成项缺官方必填 `id`（`ResponseReasoningItem.id: string`，SDK `responses.d.ts:4595`）。**设计如此**（伪造 id 更易被拒，且网关接受过），需写成明确约束 | 待处理 |
| D2 | 同上 `:140` | `singleReasoningSlot` 下同时缺必填 `summary`（SDK:4599），产出比默认更不合 schema 的项 | 待处理 |
| D3 | 同上 `:345-347` | `reasoningTextOnly` 删除请求级 `reasoning.summary`，而 pi-ai 在请求了思考级别时恒设该字段（`openai-responses.js:253-263`） | 待处理 |
| D4 | 同上 `:399` | 响应观察只认 `response.completed`，漏 `response.incomplete`（pi-ai 二者同等对待，`openai-responses-shared.js:637`） | 待处理 |
| D5 | 同上 `:403` | 已见逐项事件时不再从终态回填 `encrypted_content`（pi-ai 始终回填，`openai-responses-shared.js:417-432`） | 待处理 |
| D15 | 同上 `:110-118` | 文本合并用 summary+content，pi-ai 用 `summary \|\| content`（`SH:582-584`） | 待处理 |

### C 组 · 文档与代码不符

| # | 位置 | 问题 | 状态 |
| --- | --- | --- | --- |
| D6 | `responses-reasoning-echo.js:23-24` | 头注释称插在 `function_call` 之前，实现插在**轮首**（`:332`） | 待处理 |
| D7 | `PITFALLS.md:45` | 称"合成的项一直是 content-only"，代码默认**双槽** | 待处理 |
| D8 | `DESIGN.md:75, 84` | 「声明两项」「两个默认值」，实际**四项** | 待处理 |
| D9 | `README.md:33, 47, 51` | 「三组开关」「三个选项」，实际四项 | 待处理 |
| D10 | `scripts/build.mjs:84-93` | 嵌入浏览器的 `defaults` 漏 `reasoningTextOnly`（`Config` 有而 `defaults` 无） | 待处理 |
| D11 | `responses-reasoning-echo.js:249-269` | JSDoc 中 `@param body` 出现两次，轮次顺序的散文错挂在第一个上 | 待处理 |
| D12 | `PITFALLS.md:25` | 编号 `## 5.0` 紧跟 `## 5`，随后 5.1–5.4，属追加式编号 | 待处理 |

### D 组 · 死代码与仓库卫生

| # | 位置 | 问题 | 状态 |
| --- | --- | --- | --- |
| D13 | 仓库根 | 15 个 `.tmp-*.mjs` 一次性探针（30.3 KB），已确认是日志配对/压缩时间线/体积观测脚本 | 待处理 |
| D14 | `.gitignore` | 只有 `*.tmp`，**不匹配** `.tmp-*.mjs`，导致 15 个文件长期以未跟踪状态出现 | 待处理 |

### E 组 · 新增（发现即登记，不混入当前阶段）

| # | 位置 | 问题 | 状态 |
| --- | --- | --- | --- |
| E1 | `src/index.js` 日志路由块 | 用 `ctx.get('webServer')` 取服务；激活时机早于 webServer 注册时拿到 `undefined`，路由被**静默跳过**（探针实测 404）。改为第一方的 `ctx.inject(['webServer'], webCtx => webCtx.effect(() => webCtx.webServer.register(route)))` 后恢复 200 | 已修 |

---

## 八、风险与对策

| 风险 | 对策 |
| --- | --- |
| 响应式句柄在 `apply` 参数上的行为与样板不一致 | 阶段 1 第一步先作文本级验证；不行则退回 `configEditor` 读取 |
| 客户端写队列接口未逐字确认 | 抄 `dsh-client-ui-settings-shell/lib/client.js:176` 的 `ShellCardController` |
| 旧 `settings.yaml` 中的 `llm-compat` 分节 | 由 DSH 的 `settings.yaml.imported` 机制接管，README 说明 |
| 测试假 ctx 与新服务形态脱节 | 先让测试同时接受两种形态，再删旧分支，保证覆盖率不下降 |
| 沙箱导致测试假失败 | 运行时把 `TEMP`/`TMP` 指向工作区目录 |

---

## 九、提交切分

1. `feat: 宿主半适配 0.1.7-rc.2 设置模型`（阶段 1）
2. `feat: 客户端设置页迁移到 configForms`（阶段 2）
3. `chore: 清理缺陷与死代码`（阶段 4，可再拆）

推送仅在需要真机验证时进行；其余只做本地提交。

---

## 十、流程约定

1. 每阶段结束：`node scripts/build.mjs` → `--check` → `npm test` → 更新本文件状态 → 本地提交。
2. 测试运行方式（沙箱内必须）：把 `TEMP`/`TMP` 指向工作区目录，否则 `mkdtemp` 被拒，14 项假失败。
3. 阶段 3 需要移除环境变量并重启 DSH，属真机操作，由使用者执行或明确授权。
4. 不擅自扩大范围：`git-for-dsh` 与 UI 结构不在本计划内。
5. 本文件在阶段 5 结束后删除，不进入长期文档集。

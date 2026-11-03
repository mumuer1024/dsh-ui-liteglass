# dsh-ui-liteglass × DSH 0.2.1-rc.2 — 兼容性审计与迭代方案

| 项 | 值 |
|---|---|
| 审计日期 | 2026-11-02 |
| 审计基线 | DeepSeek Harness **0.2.1-rc.2**（CLI 与全部 `@deepseek-ai/dsh-*` 包） |
| 审计对象 | `dsh-ui-liteglass@0.1.0`（本仓库，HEAD `586943c`） |
| 线上安装 | `web` profile 的 `dsh.profile.bundles` 之一；安装副本 `lib/` 与本仓库逐字节一致 |
| 性质 | **只读审计**；本次审计未修改源码、配置或线上环境 |
| 后续 | §7 记录按 P0+P1 实施的 `v0.2.0` 修复；§1–§3 与附录为**审计时 0.1.0 基线**快照 |

---

## 0. 结论摘要

插件仍然**可用**：宿主半部在当前 DSH 上正常挂载并响应（`GET /ui-liteglass/config` 实测 200），
客户端模块契约、`slots`、`theme.overrideTokens` 等关键接缝都还在。但以 0.2.1-rc.2 为基线，
存在 **1 处明确的契约破坏**、**一类未鉴权的写入口**、**一个 live-reload 致命路径**，
以及若干因 0.2.1 调色板与设置页重构而产生的语义漂移。

| 维度 | 结果 |
|---|---|
| 宿主半部挂载（bundle patch、`webServer` 路由） | ✅ 兼容 |
| 客户端半部加载（`dsh.client`、`__ModuleLoader__`、`exports.inject`） | ✅ 兼容 |
| `settings` 服务读取原生主题偏好 | ❌ **已破坏**（服务已改为 `SettingsForms`） |
| 设置页入口 `settings.section` | ✅ 仍在，但与 0.2.1 新布局语义冲突 |
| 覆盖的 11 个 `--dsw-*` token | ✅ 全部仍存在，但语义已变 |
| 路由卸载/重载 | ❌ 未用 `ctx.effect`，live patch 重载会抛 duplicate 路由 |
| 路由鉴权 | ❌ 完全未鉴权（线上经反代暴露） |

---

## 1. 基线与事实

- 当前 DSH：`0.2.1-rc.2`（`dsh --version` 与 `@deepseek-ai/dsh/package.json` 一致）。
- 安装副本 `web/node_modules/dsh-ui-liteglass/lib` 与仓库 `lib` 用 `diff -r` 比对**无差异**。
- 仓库分支 `main`，HEAD `586943c`，审计前后工作树均干净。
- 本 README 自述「支持 DSH `0.1.0-rc` 线，测试于 `0.1.0-rc.7`」——比现网落后两条版本线。
- 原生主题偏好实际为 `dark`（profile patch 中 `ui-theme.config.preference: dark`），
  而插件 `/ui-liteglass/state` 实测返回 `"system"`，即该端点已失效。
- 实测未带任何 cookie 的 `GET http://127.0.0.1:3081/ui-liteglass/config` 返回 200。
- 插件自带 3 套测试（19 + 13 + 宿主用例）全部通过，但均为自洽 mock。

---

## 2. 兼容性矩阵

| # | 插件依赖 | 0.2.1-rc.2 现状 | 判定 |
|---|---|---|---|
| 1 | `cordis.patch.yml` 的 `insert: [{id, name, inject}]` + `dsh.bundle.patch` | bundle 层组合逻辑未变（`dsh` CLI `profile-boot`） | ✅ |
| 2 | `webServer.register({kind: 'exact' \| 'prefix', path, handler})` | 签名、`kind`、前缀匹配 `startsWith(prefix + "/")` 全部一致（`dsh-host-webserver`） | ✅ |
| 3 | `settings.get('ui-theme').preference` | `settings` 服务已改为 `SettingsForms`，只有 `describe/update/replace/mutate/write/configure`，**无 `get()`** → 调用抛错被 `try/catch` 吞掉，恒返回 `'system'` | ❌ **破坏** |
| 4 | 客户端 `window.__ModuleLoader__.load({id, factory})` + `exports.inject/apply` | 格式未变；`id` 仍须等于包名（`dsh-client-modules`） | ✅ |
| 5 | `dsh.client: {platform: "web", inject: [...]}` + `exports["./client"]` | 解析规则一致，仍校验 `platform === 'web'` 与 `./client` 导出 | ✅ |
| 6 | `slots.inject('settings.section', …)` + `register({name, id, order, label})` | 槽位仍由 settings-general 渲染；但原生 Appearance 行已迁入 General 页的 `settings.general.item` | ⚠️ 可用但入口分裂 |
| 7 | `theme.overrideTokens(source, {'--x': {light, dark}})` | 契约未变；自动 pin source、自动挂 disposer **只对动态包**成立，本插件是 bundle 静态客户端模块，不经该 facade | ⚠️ 卸载不还原 |
| 8 | `ctx.on('theme/change')` | 事件仍在，语义不变 | ✅ |
| 9 | 覆盖的 11 个 `--dsw-*` token | 全部仍存在；但 `--dsw-alias-brand-primary` 已变为黑白主色，`--dsw-alias-bg-layer-1/2/3` 在 dark 是三档不同层次 | ⚠️ 语义漂移 |
| 10 | `$DSH_HOME/ui-liteglass/` 数据目录 | `DSH_HOME` 仍是官方解析变量（`dsh-home-paths`） | ✅ |
| 11 | 路由鉴权 | 0.2.1 只对 **index** 与 **`/api`** 鉴权；插件 4 条路由无任何鉴权 | ❌ |
| 12 | 上传处理 | `readBody` 全量缓存后才判 8MB 上限 | ❌ 内存放大 |
| 13 | 路由生命周期 | 未包 `ctx.effect` → 卸载不释放；`patchReload: "live"` 重载后重复注册会抛 `duplicate … route` | ❌ |
| 14 | 背景层 DOM | 向 `#root` 前插入固定 div、向 `head` 写 `<style>` | ⚠️ 违反当前官方约定 |
| 15 | 设置面板文案 | 硬编码中文，未走 `ctx.locale` | ⚠️ |
| 16 | 组件可访问性/样式 | 内联 `rgba(...)` 常量；无 `aria-pressed` / `aria-valuetext` | ⚠️ |
| 17 | 版本声明与 peerDeps | README 停在 `0.1.0-rc.7`；`@deepseek-ai/cordis: ^4.0.1`（官方包统一 `~4.0.5`） | ⚠️ 陈旧 |
| 18 | 测试 | 3 套测试全通过，但无法捕获 #3 / #11 / #13 | ⚠️ 假安全 |

---

## 3. 问题清单

### P0 — 必须修

**P0-1 `settings` API 破坏（#3）**
`lib/index.js` 的 `nativePreference()` 调用 `settings.get('ui-theme')`；0.2.1 的 `settings`
是 `SettingsForms`，没有 `get()`。异常被 `try/catch` 吞掉后返回 `'system'`，而实际偏好是 `dark`。
客户端目前未调用 `/ui-liteglass/state`，所以影响是「死端点 + 错误语义」，一旦启用会误导。

**P0-2 全部路由未鉴权（#11）**
0.2.1 的鉴权只覆盖 index（`connection.authorizeIndex`）与 `/api`（`connection.admit`）。
插件的 config 读写、上传、背景图读取都注册为独立的 `webServer` 路由，不经过任何鉴权。
线上经 nginx 反代（`dsh.kotya → 127.0.0.1:3081`）暴露，等于局域网/Tailnet 内任何人可读写外观配置
并上传文件。另外 `POST` 只做 `JSON.parse`，不校验 `Content-Type`/`Origin`，
`text/plain` 简单请求即可写入，构成跨站写（CSRF）。

**P0-3 路由未绑定生命周期（#13）**
`webServer.register(...)` 没有包在 `ctx.effect` 里：卸载不释放路由，且 `patchReload: "live"`
重载 profile patch 时会因重复路径抛 `duplicate exact route`，插件会挂死到重启。

### P1 — 行为/体验偏差

**P1-1 设置入口分裂（#6）**
0.2.1 把原生 Appearance 行放进了 General 页的 `settings.general.item`；插件仍注册独立的
`settings.section`（label「外观 (Appearance)」），出现同名两个入口。

**P1-2 Token 语义未重标（#9）**
- `--dsw-alias-brand-primary` 在 0.2.1 是黑白主色（light `bluish-1000`，dark `bluish-50`），
  覆盖成 accent 会把黑白主按钮染成彩色。
- `--dsw-alias-bg-layer-1/2/3` 在 dark 是 `875/850/800` 三档，插件拉平成同一颜色，
  抹掉嵌套层级深度。
- 未覆盖 `--dsw-alias-bg-overlay`、`--dsw-alias-bg-module-platform` 等新面，
  弹窗、卡片选中态仍是实心，与「玻璃」不一致。

**P1-3 卸载不还原（#7）**
`overrideTokens` 返回的 disposer 未挂到 fiber；README 的「移除插件即还原」只在刷新页面后成立。

**P1-4 上传健壮性（#12）**
超限不提前终止（可被大体积请求放大内存）；无 magic-byte 校验（仅有扩展名白名单）；
旧壁纸不回收，磁盘单调增长。

### P2 — 规范/现代化

- **P2-1** 向 `#root` 兄弟节点与 `document.head` 写 DOM：0.2.1 官方插件规范明确要求
  "Do not write DOM outside your component or append to `document.body`"。
- **P2-2** 无 i18n（文案硬编码中文）、无 a11y（分段控件缺 `aria-pressed`、滑块缺 `aria-valuetext`）、
  内联色值未走 `--dsw-*` token。
- **P2-3** 兼容性声明与 peerDeps 陈旧；测试不针对真实 DSH 契约。
- **P2-4** 仓库目录名 `dsh-ui-appearance` 与包名 `dsh-ui-liteglass` 不一致；
  `$DSH_HOME` 下同时残留 `ui-appearance/` 与 `ui-liteglass/` 两份配置（旧身份遗留，待单独清理）。

---

## 4. 迭代方案（以 0.2.1-rc.2 为基准）

### v0.2.0 — 兼容性与安全修复（小改，不动架构）

| 改动 | 做法 | 验收标准 |
|---|---|---|
| 修 `state` 端点 | 删除该路由；或改用 `settings.describe()` 找 `ns === 'ui-theme'` 的 `value.preference`，并订阅 `settings/document-updated` 刷新缓存 | 实际偏好为 `dark` 时端点返回 `dark` |
| 路由鉴权 | `inject` 增加 `connection`；handler 首行 `if (!connection.isAuthenticated(req)) return 401`（背景图 GET 一并鉴权）；要求 `Content-Type: application/json` 或校验 `Origin`/`Host` 防 CSRF | 无 cookie 访问 4 条路由全部 401 |
| 路由生命周期 | 每条路由改为 `ctx.effect(() => webServer.register(...), 'ui-liteglass: …')` | 连续两次重载 patch 不抛 duplicate，旧路由被释放 |
| 上传加固 | 流式累计字节，超 8MB 立即 `413` + `req.destroy()`；读取头部校验 PNG/JPEG/WebP/GIF magic bytes；上传响应 `no-store`；保留最近 N 张或清理未引用文件 | 15MB 请求在 8MB 处被拒且内存不涨 |
| 卸载还原 | `ctx.effect(() => theme.overrideTokens(...))`；背景层 div 一并纳入 `ctx.effect` 清理 | 禁用插件后**不刷新页面**即恢复原生外观 |
| 文档修正 | 修正 ARCHITECTURE §2 关于「runner 自动 pin source / 自动挂 disposer」的表述；README 兼容区间改为 `0.2.1-rc` | 与代码行为一致 |

### v0.3.0 — 对齐 0.2.1 设计语言

1. **入口合并**：优先注册进 General 页的 `settings.general.item`（与原生 Appearance 同页，
   `order` 排在 appearance/font-size 之后）；若坚持独立页，label 改为「壁纸与玻璃 (LiteGlass)」
   并改走 `ctx.locale` + `locale/{zh,en}.json`。
2. **Token 层按 0.2.1 重标**：保留层级（`base = a`、`layer-1 = a + δ` …）；
   补上 `--dsw-alias-bg-overlay`、`--dsw-alias-bg-module-platform`、`--dsw-specific-selector`、
   `--dsw-alias-tooltip-bg`。
3. **Accent 成对输出**：同时给出 on-accent 前景色（浅色 accent 用深色字），
   消除当前白字压浅色 accent 的低对比。
4. **`brand-primary` 覆盖降为可选**：0.2.1 主按钮是黑白主色；默认只覆盖真正的强调面
   （link / business / focus / sidebar active），并提供「彩色主按钮」开关。
5. **a11y 与视觉一致**：分段控件加 `aria-pressed`，滑块加 `aria-valuetext`，色值改用 `--dsw-*`。
6. **`panelBlur` 收敛**：在安全的内层容器实现，或从 UI 移除——当前「可调但无效」是假功能。

### v0.4.0 — 证据化与可持续

1. **宿主集成测试**：加载真实 `dsh-host-webserver` + `dsh-settings` + `dsh-client-connection`
   后跑插件 `apply`，断言：未认证 401、超限 413、重复注册不抛、卸载后路由清空、
   `describe()` 能读到 `dark`。
2. **客户端契约测试**：用真实 `__ModuleLoader__` stub 校验 `load({id, factory})`、
   `exports.inject`、`overrideTokens` 两参调用。
3. **CI 固定基线**：devDependencies 锁 `0.2.1-rc.2` 系列；`prepublishOnly` 跑全量；
   README 写明「实测于 0.2.1-rc.2，不保证向前兼容」。

### 可选架构升级（不阻塞）

配置持久化迁移到 `ctx.storageDomain`（schema 校验 + 变更事件 + profile 级持久化，
可被 `dump-config` 观察），壁纸仍走**鉴权后**的文件路由。
收益：少一条自研存储/鉴权面；成本：中等。建议 v0.2.0 修完后再评估。

---

## 5. 验证与未验证

**已验证（只读/隔离）**

- 插件 3 套测试本地全通过，仅写 tmp 目录。
- 线上 `GET /ui-liteglass/config` 200；`/ui-liteglass/state` 200 且值错误；无 cookie 可达。
- 对照 0.2.1-rc.2 源码逐条核对 `webServer` / `slots` / `theme` / `client-modules` / `settings`。

**未验证**

- 浏览器端实际渲染（无页面控制权）：玻璃与壁纸在 0.2.1 的实际观感、设置页是否仍正常出现、
  accent 对比度问题。
- 反代 https 路径下 cookie `authority` 的表现（若将来 `secure` 语义变化，鉴权需同步）。

---

## 6. 审计边界

- 未修改插件源码、profile、`$DSH_HOME` 或任何服务；未安装/卸载/重启任何组件。
- 唯一写操作：仓库内 `npm test`（产物只在 `/tmp`）与新增本文件。
- 线上探测仅限 2 次只读 `GET`。

---

## 7. 修复记录（v0.2.0，已实施）

审计结论经确认后按 **P0 + P1** 实施，版本定为 `0.2.0`（含行为变更与新增配置字段，
按 semver 走 minor）。本节记录每条审计项的落地方式；上文 §1–§3 保留为**审计时**的
0.1.0 基线，不再代表当前代码。

| 审计项 | 修复 | 落地位置 |
|---|---|---|
| P0-1 `settings.get()` 已不存在 | 改读 `settings.describe()`，按 `ns === 'ui-theme'` 取 `value.preference`，缺失时回退 `system` | `lib/index.js` — `nativePreference()` |
| P0-2 路由完全未鉴权 | 全部 4 条路由先过 `connection.isAuthenticated(req)`（否则 401）；写路由再加同源校验与 JSON content-type 强制（跨站表单无法形成该请求） | `lib/index.js` — `authorized()` / `sameOrigin()` |
| P0-3 无 `ctx.effect`，live reload 抛 duplicate | 每次 `webServer.register` 都包进 `ctx.effect`，卸载即释放路由 | `lib/index.js` — `route()` |
| P1-1 设置入口分裂 | 注册进 `settings.general.item`（原生 Appearance 行下），不再另开一个同名「外观」页 | `lib/client.js` — `apply()` |
| P1-2 token 语义漂移 | 表面改为**单调递增不透明度阶梯**（含 `--dsw-alias-bg-overlay`、`bg-module-platform`、`specific-selector`）；`brand-primary` 改为默认关闭的 `accentButtons` 开关，开启时成对写入按亮度选取的 `label-primary-foreground` | `lib/client.js` — `SURFACE_LADDER` / `buildTokens()` |
| P1-3 卸载不还原 | 保存 `overrideTokens` 返回的 disposer 并在 `ctx.effect` 清理时释放，同时移除壁纸节点 | `lib/client.js` — `themeDispose` / teardown effect |
| P1-4 上传面硬化 | 流式读取时即执行 8 MiB 上限（超限 413，不先缓冲）；magic byte 与实际 content-type 必须一致；缓存改 `private`；成功后回收 1 小时以上且无人引用的旧文件 | `lib/index.js` — `readLimitedBody()` / `sniffImageExt()` / `pruneBackgrounds()` |

配置 schema 新增 `accentButtons`（boolean，默认 `false`）；`cordis.patch.yml` 的 `inject`
增加 `connection`；`package.json` 升至 `0.2.0`。

**验证**：`npm test` 四套共 98 项全通过（host 路由与鉴权/限流/回收、真实客户端
`apply()` 契约、配置状态机、不触碰原生颜色模式）。**未验证**：浏览器实际渲染、
线上重装后的行为、反代 https 下 cookie 语义——与 §5 相同。

**未做**（仍为后续版本）：§2 的 P2 全部项（i18n、a11y、别名映射收窄的实测依据）、
§3 的 v0.3.0 与 v0.4.0、以及可选的 `storageDomain` 迁移。

**线上状态**：本次未改动 `/root/.dsh/`、未重装插件、未重启服务，生产仍运行
`dsh-ui-liteglass@0.1.0`；本仓库代码与其安装副本已不再逐字节一致。

---

## 8. v0.2.1 交互修正（人工实测反馈）

0.2.0 上线后由维护者人工验收，基础功能正常；以下三项按反馈修正。

| 反馈 | 处理 | 落地位置 |
|---|---|---|
| 上传上限没有显式提醒；上传失败也没有提示 | 面板直接写明「单张上限 8 MiB」与支持格式；超过上限的文件在浏览器端就被拒绝（不发请求），并把实际大小（如 `9.0 MiB`）写进提示；服务端 413 / 415 / 401 / 403 与网络错误都有对应中文文案；成功也给回执 | `lib/client.js` — `onUpload()` / `uploadError()` / `STYLE.error` |
| 拖动滑块调不透明度等参数卡顿 | 连续滑块换成**分段按钮**：不透明度每档 10%（背景 0–100% 共 11 档，面板 10–100% 共 10 档），模糊每档 5px、上限 30px（7 档）。每次点击只产生一次提交，拖动不再逐像素写盘 + 重建 token 层；同值重复点击直接短路 | `lib/client.js` — `Steps` / `percentOptions` / `pixelOptions` / `patch()` |
| 重点色是原生自带还是插件注入？若为插件注入则不要取色器 | **插件注入**。核对 `dsh-client-ui-theme` 的 settings 定义：`ui-theme` 只有 `preference` 与 `fontFamily`/`fontSize`，不存在 accent / brand color 字段；0.2.x 主色本身是单色。因此取色器改为 **9 个预设色块 + 「原生」重置**，历史自定义值仍会应用并标注为「自定义色」 | `lib/client.js` — `ACCENT_PRESETS` / `Swatch` 渲染 |

两侧同时对不透明度/模糊做了网格量化（客户端 `snap`、宿主 `snapNum`），保证存储值一定
可被控件表达；旧值 `0.35` 这类会在下次保存时归到 `0.3`。默认 `backgroundOpacity` 随之
从 `0.35` 改为 `0.4`。

**验证**：`npm test` 四套共 122 项通过；`test/client-contract.mjs` 现在会渲染面板并驱动
上传流程（超限不发请求、413 有文案、格式不符被拦、成功后只发一次并有回执）。
**未验证**：浏览器实际观感（9 个色块的实际排版/对比度）、9 个占位色号仍待维护者提供
最终调色板后替换 `ACCENT_PRESETS`。

## 9. v0.2.2 交互修正（第二轮实测）

> 注意：本节记录的「面板模糊」实现（列容器 `backdrop-filter`）已在 §10 被「浮层模糊」
> 取代，保留作为决策过程记录；当前行为以 §10 与 README 为准。

0.2.1 实测后按反馈再修三项。

| 反馈 | 处理 | 落地位置 |
|---|---|---|
| 不透明度/模糊改用下拉菜单 | 四个参数（背景不透明度 11 档、面板不透明度 10 档、背景模糊 7 档、面板模糊 7 档）全部换成原生 `<select>`；一次选择一次提交 | `lib/client.js` — `Select` / `percentOptions` / `pixelOptions` |
| 重点色维持现色号，增加自定义色号输入框（不要取色器） | 保留 9 个预设与「原生」；新增纯文本色号输入，只接受 `#RGB`/`#RRGGBB`/`#RRGGBBAA`（无 `#` 自动补），回车/失焦生效；非法输入保留原文并提示，不写盘 | `lib/client.js` — `commitHex` / `STYLE.hexInput` |
| 调查面板模糊能否启用 | 见下方结论；已实现为可选功能（默认 0 = 关闭） | `lib/client.js` — `applyPanelBlur` + 属性门控 CSS |

### 面板模糊：调查结论与实现方式

**能做，但要先接受一个事实**：`_frame` 是 `position:relative` 的 grid 容器，
`_sidebarCol` / `_centerCol` / `[data-rightbar-col]` 是三条并列的 grid 轨道。也就是说，
“面板背后”在常规三栏布局里**只有壁纸**——而壁纸已被 `backgroundBlur`（`filter` on
`.dsh-ui-liteglass-bg`）模糊过。所以常规布局下，面板模糊 ≈ 背景模糊，肉眼差别很小。

**真正有差别的是“面板压在内容之上”的场景**：右侧详情面板在无轨道时浮在对话上、窄屏侧栏
抽屉浮在对话上。这两处 `backdrop-filter` 会把下层的对话内容一起磨砂，是背景模糊给不了的。

**为什么 0.1.0 当年会“把设置页挤到侧栏”**：给列容器加 `backdrop-filter` 会让它成为
`position:fixed` 后代的包含块，并新建层叠上下文；当年的设置页不是 portal 到 `<body>`
的。0.2.1 的 settings shell 走 `createPortal(…, document.body)`，因此该具体故障不再复现；
残余风险只落在“列容器内部的 fixed 元素”上。当前代码里此类元素基本只有
`dsh-client-ui-sidebar` 在 `[data-windows-titlebar]`（Windows 桌面壳）下的窗口按钮，
浏览器/GUI 场景不触发。

**实现取舍**：不碰 DSH 的布局，不新增包装元素，直接对三个列容器加 `backdrop-filter`；
规则用类名**后缀**匹配（`[class*="_sidebarCol"]`）与稳定属性 `[data-rightbar-col]`，
所以 DSH 改版只会让效果失效、不会误伤别的元素。全部规则挂在
`:root[data-dsh-ui-liteglass-panel-blur]` 下，设置回 0 时属性被移除、规则整段不存在，
恢复原布局无需刷新。

**未验证**：真实浏览器下的观感与 GPU 开销（3 个整列 `backdrop-filter` 层），以及
Windows 桌面壳下 fixed 窗口按钮是否位移——这两点只能由人工实测确认；若发现异常，把
面板模糊设回 0 即可完全回退。

## 10. v0.2.3 浮层模糊（第三轮实测）

> 实测反馈：0.2.2 的“面板模糊”与背景模糊**呈现完全一致的模糊行为**，期望的是设置面板、
> 弹出面板、输入框这类**浮层**各自的独立模糊。

这个反馈是对的，而且是结构性的，不是调参问题：

- `_frame` 是 `position:relative` 的 grid，`_sidebarCol` / `_centerCol` / `[data-rightbar-col]`
  是**并列轨道**，面板背后只有壁纸。
- 壁纸已被 `backgroundBlur`（`.dsh-ui-liteglass-bg` 的 `filter: blur()`）模糊过，所以给轨道
  再加 `backdrop-filter` 等于把同一张图再模糊一次 → 必然与背景模糊观感一致。

### 找到的原生接缝

DSH 自身的“材质”体系里，浮层模糊已经是一个令牌：

| 令牌 | 原生默认 | 谁消费 | 结果 |
|---|---|---|---|
| `--dsw-mask-blur` | `none` | 对话框/设置页的蒙层（`backdrop-filter:var(--dsw-mask-blur)`，见 `dsh-client-ui-settings-general` 的 `mask` 规则） | 默认**不磨砂**，覆写即可让蒙层背后的页面失焦 |
| `--dsw-menu-backdrop-filter` | `blur(40px) saturate(150%)` | 菜单/弹出面板的材质层（`_material_*`） | **本来就磨砂**，插件不需要也不应该再动 |

### 落地

- `panelBlur` 语义改为「浮层模糊」，只覆写 `--dsw-mask-blur`（light/dark 同值），0 写回 `none`。
- 删除 0.2.2 的三条列容器 `backdrop-filter` 规则与根节点标记属性——它们正是“和背景模糊一样”的来源。
- 控件文案改成「浮层模糊」，并注明：弹出菜单本身已有系统 40px 磨砂；侧栏/输入框背后只有壁纸，
  看不出差别，那种情况请用背景模糊。

### 仍然存在的边界

- **侧栏面板与输入框**在常规布局下无法产生“独立于背景模糊”的效果——它们背后没有别的内容。
  只有窄屏抽屉/右侧浮层压在对话上时才有真实差别，而这条路径已由 0.2.2 的列规则覆盖，
  代价是与背景模糊重复且引入类名耦合，故一并移除。若后续确需“浮层压内容”的磨砂，
  应单独评估右栏 `[data-rightbar-col]`（它 `position:relative` 且是唯一常态重叠的列）。
- 蒙层令牌是全局的：影响所有使用该令牌的对话框（包括其他插件的），这符合“浮层统一磨砂”的预期。
- **未验证**：真实浏览器观感、以及不同页面（设置/插件弹窗）蒙层是否都走同一令牌。

## 附录 A：DSH 侧参照索引

| 主题 | 位置 |
|---|---|
| 路由注册与前缀匹配 | `@deepseek-ai/dsh-host-webserver` `lib/index.js` — `register()`、`match()` |
| 设置服务（无 `get()`） | `@deepseek-ai/dsh-settings` `lib/index.js` — `class SettingsForms` |
| 主题命名空间 `ui-theme` | `@deepseek-ai/dsh-client-ui-theme` `lib/client.js` — `THEME_SETTINGS_NAMESPACE` |
| `overrideTokens` 契约 | `@deepseek-ai/dsh-client-ui-theme` `lib/client.js` / `lib/types/client/index.d.ts` |
| 原生 Appearance 行注册 | `@deepseek-ai/dsh-client-ui-theme` `lib/client.js` — `settings.general.item` |
| `settings.section` 渲染 | `@deepseek-ai/dsh-client-ui-settings-general` `lib/client.js` |
| index 鉴权 | `@deepseek-ai/dsh-host-frontend-static` `lib/index.js` — `authorizeIndex` |
| `/api` 鉴权 | `@deepseek-ai/dsh-client-connection` `lib/index.js` — `admit()` / `isAuthenticated()` |
| 客户端模块清单 | `@deepseek-ai/dsh-client-modules` `lib/index.js` — `parseDshClient()` |
| 动态包 facade（插件不使用） | `@deepseek-ai/dsh-cordis-client-runner` `lib/client.js` — `guardedTheme` |
| `DSH_HOME` 解析 | `@deepseek-ai/dsh-home-paths` `lib/index.js` — `resolveDshHome()` |
| 插件规范（UI） | `dsh-agent-preset/skills/cordis-plugin-development/references/{ui-plugin,practices}.md` |

## 附录 B：插件侧关键位置（审计时 0.1.0 基线）

| 主题 | 位置 |
|---|---|
| `nativePreference()`（已失效） | `lib/index.js` — `settings.get('ui-theme')` |
| 4 条路由注册（未鉴权、未挂 effect） | `lib/index.js` — `webServer.register(...)` ×4 |
| 上传读取与大小检查 | `lib/index.js` — `readBody()` / `MAX_IMAGE_BYTES` |
| 背景层 DOM 插入 | `lib/client.js` — `applyBackground()` |
| Token 层构建与覆盖 | `lib/client.js` — `buildTokens()` / `applyThemeLayer()` |
| 设置页注册 | `lib/client.js` — `slots.inject('settings.section', …)` |
| bundle patch | `cordis.patch.yml` |
| 兼容性声明 | `README.md` / `README.zh-CN.md` — Compatibility |
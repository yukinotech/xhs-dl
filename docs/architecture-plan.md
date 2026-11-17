# xhs-dl：Agent 优先 CLI 编程目标与架构方案

日期：2026-11-17。状态：供讨论和后续实施的设计基线，本文记录已落地的产品契约；核心登录、查询、搜索、分页与下载已实现，实际支持范围与实测状态见 README、roadmap 与 capabilities。技术约束：纯 HTTP、纯终端、无浏览器依赖，适配 SSH 与无桌面服务器。

补充发行方式：使用 Bun 1.4.4+ 将 TypeScript CLI 与运行时打包为各平台独立可执行文件。开发、依赖管理和 Node.js 入口保持不变；独立产物的使用者无需安装 Node.js、PNPM 或 Bun。构建目标、命令与实测边界见 README。

## 1. 产品目标与范围

用 Node.js、TypeScript 和 PNPM 实现一个既适合人在终端操作，也适合 Claude Code、Codex 等 Agent 通过子进程调用的小红书 CLI。核心工作流是：发现能力 → 登录或恢复会话 → 搜索/列举帖子 → 获取详情 → 规划下载 → 下载与核对结果。

第一版完整目标：

| 能力 | 目标行为 |
| --- | --- |
| 登录 | 手机号和验证码登录；提供扫码与显式 Cookie 文件导入作为替代入口 |
| 会话 | 跨进程保存、恢复、检查、更新和清除登录态；不同 profile 隔离 |
| 详情 | 接受帖子完整链接、短链、分享文本，以及带访问参数的 ID；返回标题、正文、作者、图片/视频 CDN 候选等 |
| 搜索 | 按关键词搜索帖子，分页、限量、排序和帖子类型筛选 |
| 用户 | 查看登录者/指定用户资料；分页或遍历其发布、喜欢、收藏帖子，明确区分有权读取、私密与未知状态；支持直接下载各类列表 |
| 下载 | 图集、视频、Live Photo 关联媒体；创建多级目录；可配置命名、清晰度、重试、断点恢复与去重 |
| 配置 | 持久参数可由命令行、环境变量或配置文件提供，明确覆盖顺序 |
| Agent | 完整帮助、机器可读能力与 Schema、稳定 JSON/JSONL、退出码、无交互模式、可分步登录、配套 Skill |

范围约定：

- “维持登录”指尽可能恢复和更新有效会话；过期、平台退出或安全校验仍可能要求重新登录。
- “全部帖子”指当前登录身份可访问且平台实际返回的帖子，不承诺获取隐藏、删除、私密内容或突破平台分页上限。
- 第一版聚焦读取和下载，包含读取本人和指定用户的喜欢/收藏列表；执行发布、点赞/取消点赞、收藏/取消收藏、评论、私信等写操作，以及网页控制台、HTTP 服务和 MCP 服务不列入本轮目标。
- 所有登录、详情、搜索、用户列表与下载均通过 HTTP(S) 完成；协议签名、设备状态构造和必要的加解密在本地 Node.js 内实现，不运行网页 JavaScript，不依赖浏览器、Playwright、CDP 或外部签名服务。
- 支持 macOS、Linux、Windows 上满足 Node.js 运行要求的终端；SSH、无桌面、无 DISPLAY 环境是正式支持场景。安装后只需 CLI、网络和可写的应用状态目录，不需要桌面会话、Python/Go 服务或后台守护进程。
- 扫码时在 shell 输出二维码，用户用手机小红书扫描并确认；短信时在 shell 输入手机号和验证码。Agent 可通过分步命令完成相同的 HTTP 流程。

用户能力的命令、权限、数据模型、分页恢复和直接下载流程见 [用户内容详细功能设计](user-content-spec.md)，该文档是用户模块的实施与验收基线。

## 2. 参考项目结论

已有 8 个只读参考快照，提交及许可证观察见 [references-lock.json](../references-lock.json)，完整源码证据见 [reference-research.md](reference-research.md)。参考阶段核对了 CLI 输出、签名请求、纯 HTTP 登录和会话恢复实现。后续已使用用户授权会话完成内容/下载实测，证据见 roadmap；以下源码分析保留其固定快照边界。

| 参考项目 | 用于设计的部分 | 不应直接据此假设 |
| --- | --- | --- |
| XHS-Downloader | 图集、视频多档位、Live Photo、下载和文件命名需求 | 自带完整手机号登录；代码可不经许可证判断直接搬用 |
| xiaohongshu-mcp | 详情类型、字段与用户交互语义对照 | 其浏览器实现符合本项目运行约束；不沿用其登录执行方式 |
| Spider_XHS | **主要协议参考**：纯 HTTP 二维码/短信登录、完整会话与设备状态 | 只拿一个 web_session 就能完整恢复；其当前协议在本机已验证 |
| MediaCrawler | 媒体归一化、接口字段与错误行为对照 | 其浏览器登录或技术栈需要整体移植 |
| ReaJason/xhs | HTTP 登录流程、SDK 分层与接口字段对照 | 老示例无需签名适配即可运行；旧下载封装没有参数问题 |
| xiaohongshu-cli | 本地签名、HTTP 搜索分页和用户查询、JSONL 与字段选择 | 匿名 session 等于账号登录；搜索卡片封面等于完整图集 |
| xhs-downloader-api | 核心业务与 provider、任务、下载记录的边界 | 第一版必须建设服务端、WebUI、复杂任务平台 |
| xhs-batch-downloader | 第三方解析依赖的反例 | 第三方网站返回结果可视为原生稳定能力 |

特别注意：Spider_XHS 快照的短信登录包含设备初始化、签名、Cookie 合并、验证码校验和密钥相关状态；它不是三个裸 HTTP 请求即可保证完成的功能。本项目明确承担这部分协议适配；其可行性先于大规模功能实现验证，协议失败时返回明确错误，不自动引入浏览器替代。

参考优先级调整为：Spider_XHS 的 HTTP 登录与状态管理 → xiaohongshu-cli 的本地签名/搜索/用户查询 → ReaJason/xhs 的接口对照 → 其他项目的媒体与下载语义。历史调研中的浏览器路线仅保留为上游实现记录，不是本项目的架构选择。

参考源码保持只读，不在其目录安装依赖或实验。默认独立实现；如果确需复用代码或资源，逐项记录来源和适用授权，不将参考项目当成无条件可复制的代码库。

## 3. 技术决策

| 项目 | 建议 | 理由与边界 |
| --- | --- | --- |
| 运行时 | Node.js 22.22.2 / 24.15+ / 26+，当前在 22.22.2 验证 | 锁定受支持的运行范围，实施时固定最低补丁版本；不依赖用户全局 TS 运行器 |
| 语言 | TypeScript strict、ESM | 领域模型与错误类型明确；发布编译后的 JavaScript 和类型声明 |
| 包管理 | PNPM，packageManager 固定版本，提交 pnpm-lock.yaml | CI 使用 frozen lockfile，发布前验证干净安装 |
| CLI | Commander | 子命令、参数校验、帮助入口；所有输出和退出仍由统一 renderer 管理 |
| Schema | Zod | 配置、输入、输出校验，导出 JSON Schema；输入严格，平台原始字段允许兼容扩展 |
| HTTP 传输 | Node fetch + streams + AbortController | API 请求、短链和媒体统一使用 HTTP(S)；transport 显式处理 Cookie jar、代理、重定向与超时 |
| 协议与签名 | 本地 TypeScript 模块，按需使用 node:crypto | 请求规范化、签名、设备/会话状态、密钥交换与响应解码；不依赖网页执行或远程签名服务 |
| 二维码与终端输入 | 本地纯 JS 二维码编码、终端渲染和 readline | 输出可扫码的字符矩阵及可选纯文本文件，TTY 接收手机号/验证码；不打开窗口或拉起常驻进程 |
| 配置 | TOML，默认文件名 xhs-dl.conf | 比 flags-per-line 更适合结构化设置；明确这不是 yt-dlp 配置文件语法兼容 |
| 状态 | 权限受限的 JSON 文件、原子替换、profile 文件锁 | 首版避免数据库；下载归档使用有锁的 JSONL，可在规模需要时换成 SQLite |
| 开发 | tsc 构建、tsx 开发、Vitest 测试、ESLint/Prettier | 先保持单包模块化，避免为 CLI 预设 monorepo 和服务平台 |

运行时生命周期依据 [Node.js 发布计划](https://github.com/nodejs/Release#release-schedule)。工具能力依据 [Commander](https://github.com/tj/commander.js)、[Zod](https://zod.dev/)、[PNPM 配置文档](https://pnpm.io/settings)；具体依赖版本在初始化时核对并锁定。

### 分层结构

```text
人 / Agent
    ↓ argv、stdin
CLI：命令注册 / 参数解析 / 帮助 / JSON 与终端输出
    ↓ 类型化输入
Application：Auth / GetNote / Search / ResolveViewer / ListUserNotes(kind) / PlanDownload / Download
    ↓ 领域对象与端口
Domain：Note、NoteSummary、Media、Session、Page、DownloadPlan、AppError
    ↓ 可替换实现
Adapters：XhsHttpClient / LocalSigner / DeviceContext / SessionStore / FileSystem / Transport
```

业务核心不直接调用 process.exit、不输出终端文本，也不依赖 Commander。CLI 和将来的 SDK/MCP 适配器复用同一组 use case。

### 纯 HTTP 协议路线

1. 建立 XhsHttpClient：封装二维码、短信、账号检查、帖子详情、搜索、用户资料及发布/喜欢/收藏分页接口。媒体由独立下载模块通过 HTTP(S) 传输。
2. 将请求规范化与签名单独放入 protocol 模块：明确 query 排序与编码、body 的实际发送字节、时间戳和设备上下文，签名后不得由 transport 重新序列化改变请求。不同接口的签名差异在协议层处理。
3. DeviceContext 管理匿名设备初始化、设备标识、协议版本、密钥材料和计数器；SessionStore 保存 Cookie jar 与可序列化上下文。一次 CLI 退出后，下次命令仅凭本地状态和 HTTP 即可继续。
4. 登录和搜索等 API 能力是首版必需目标，纯 HTTP 短信不再列为后续增强。API 暂时不兼容时明确报错并修复协议适配，不能悄悄改走浏览器或第三方解析/签名服务。
5. 帖子详情优先使用结构化 HTTP API；必要时可通过 HTTP 获取 HTML 并静态提取其中的 JSON 状态，但不执行远端脚本，也不把此方式作为搜索/登录的替代品。只对缺少详情数据等明确条件做有限回退，安全挑战和限流不反复重试。
6. 删除面向用户的 browser/http provider 选择；CLI 只有一种 HTTP 执行架构。内部协议实现可以版本化替换，对外命令和 Note/Media 数据结构保持稳定。

建议目录：

```text
src/
  cli/             # commands、command registry、help、renderers
  application/     # use cases
  domain/          # models、ports、errors、schemas
  api/             # auth、notes、search、users HTTP clients、normalizers
  protocol/        # canonical request、local signer、device context、crypto
  auth/            # session manager、persisted challenge、profile lock
  download/        # planner、template、transfer、archive
  config/          # schema、loader、precedence
  infrastructure/  # filesystem、transport、redaction
skills/xhs-dl/
  SKILL.md
  references/      # commands、schemas、workflows、troubleshooting
docs/
tests/fixtures/    # 合成/脱敏数据，不含真实凭证
```

## 4. CLI 命令契约

可执行命令统一叫 `xhs-dl`。`--format` 表示输出格式；`-o/--output` 专门表示下载文件名模板，避免混淆。

| 命令 | 用途 |
| --- | --- |
| `xhs-dl -h` / `--help` | 顶层帮助与关键 Agent 契约 |
| `xhs-dl -H` / `--help-all` | 完整离线手册，包含所有子命令、默认值、示例、模板、错误和退出码 |
| `xhs-dl <command> --help` | 指定命令说明 |
| `xhs-dl capabilities --format json` | 命令、输入输出 Schema 版本、HTTP 接口能力、当前协议版本与是否需要登录；不发起登录 |
| `xhs-dl schema [name] --format json` | 输出指定 Schema，name 省略则列举 |
| `xhs-dl auth login --method sms [--phone <phone>]` | 在 TTY 提示输入未提供的手机号，发送短信，再提示输入验证码 |
| `xhs-dl auth login --method qr` | shell 打印二维码，当前进程通过 HTTP 轮询，手机扫码确认后保存登录态 |
| `xhs-dl auth start --method sms --phone <phone>` | 创建可跨 CLI 调用继续的登录挑战并发送一次验证码 |
| `xhs-dl auth verify --challenge <id> --code-stdin` | 从标准输入读取验证码并继续原登录上下文 |
| `xhs-dl auth start --method qr` | 创建并保存扫码挑战；human 模式打印二维码，JSON 返回 qr_text、到期时间和 challenge ID |
| `xhs-dl auth challenge <id>` | 扫码时通过 HTTP 查询一次并落盘，短信时返回本地阶段；不重发短信或重建二维码 |
| `xhs-dl auth wait <id> [--timeout <seconds>]` | 当前进程按间隔轮询已有扫码挑战，超时后退出，可再次 wait |
| `xhs-dl auth cancel <id>` | 本地终止挑战并清除临时状态；平台支持取消接口时同步调用 |
| `xhs-dl auth status [--check]` | 本地状态；check 执行真实账号有效性检查 |
| `xhs-dl auth import --cookie-file <path>` | 显式导入指定文件，检查后保存；不扫描其他应用的凭证 |
| `xhs-dl auth logout` | 清除当前 profile 的本地凭证与待完成挑战；不承诺注销平台其他设备 |
| `xhs-dl note get <url-or-id>` | 返回规范化完整详情，纯 ID 可搭配 `--xsec-token` 和 `--xsec-source` |
| `xhs-dl search notes <keyword>` | 关键词搜索，返回摘要和继续获取详情所需的访问参数 |
| `xhs-dl me get` | 检查并返回真实登录者资料 |
| `xhs-dl me notes/likes/favorites` | 本人发布/喜欢/收藏列表，分别分页或遍历 |
| `xhs-dl user get <url-or-id>` | 指定用户资料，保留主页访问参数 |
| `xhs-dl user notes <url-or-id>` | 指定用户发布帖子摘要；`--all` 遍历全部可见结果 |
| `xhs-dl user likes/favorites <url-or-id>` | 有权限时读取对应喜欢/收藏列表，私密与空列表明确区分 |
| `xhs-dl user access <url-or-id> [--check]` | 三种列表的权限观察；check 显式发起有限 HTTP 探测 |
| `xhs-dl download [url...]` | 下载一条或多条帖子；支持 `--input <file-or-dash>` 批量输入 |
| `xhs-dl download --user <me-or-user> --source posts/likes/favorites` | 复用用户列表的权限与分页逻辑，显式下载对应来源 |
| `xhs-dl config init/show/validate/path` | 生成、脱敏查看、校验配置与查询实际目录 |
| `xhs-dl doctor --format json` | 诊断 Node、目录权限、会话元数据与本地协议模块；可显式请求网络连通检查 |
| `xhs-dl version --format json` | 程序、协议和构建版本 |

全局参数：`--config`、`--no-config`、`--profile`、`--format human|json|jsonl`、`--fields`、`--non-interactive`、`--quiet`、`--verbose`、`--timeout`、`--request-timeout`、`--retries`、`--proxy`、`--no-color`。单位分别为整体超时秒、单请求超时秒、额外重试次数，必须写入帮助。

查询参数：`--limit`、`--page-size`、`--cursor`，搜索另有 `--sort relevance|latest|likes`、`--type all|image|video`。筛选能力必须由 HTTP API 适配层声明，不支持的组合返回明确错误。首版搜索与用户列表默认最多 20 条；`--limit` 与 `--all` 互斥。自动翻页受整体超时及 `--max-pages` 约束，默认最多 100 页；达到限制必须返回未穷尽状态。

用户六种列表的筛选、权限、列表恢复 cursor、`--refresh` 与来源下载参数以 [用户内容详细设计](user-content-spec.md) 为准；帖子发布、喜欢、收藏分别声明能力与验证状态。

批量输入用 `--input-format urls|jsonl` 显式声明。urls 每行一个链接；jsonl 每行一个 NoteRef，不直接猜测 envelope。`--input -` 与 `--code-stdin` 分属不同命令，不混用标准输入。

## 5. Agent 交互协议

### 帮助与发现

`-h` 必须包含用途、命令总览、登录前置条件、JSON 调用例子、stdout/stderr 规则、退出码概要、`-H`/Schema/Skill 入口。`-H` 包含完整文档，但允许 Agent 通过子命令帮助和 Schema 分段读取。

命令元数据定义在同一 registry 中，用于生成参数、帮助、capabilities 和 Skill 命令参考；构建时检查差异，避免 Skill 里出现已删除或并不存在的参数。

`--format auto` 不作为公开枚举：未显式给 format 时，TTY 为 human，非 TTY 为 jsonl。自动化示例始终显式指定 format。非 TTY 或 `--non-interactive` 下不读取提示、不弹交互选择；缺信息立即返回结构化错误。human 模式二维码在终端渲染；JSON/JSONL 模式只返回结构化二维码内容与状态，不在 stdout 混入字符画。

### JSON 与 JSONL

JSON 模式 stdout 只输出一个 envelope；日志、进度和调试输出进入 stderr，敏感值脱敏。

```json
{
  "schema_version": "1.0",
  "request_id": "synthetic-request-id",
  "command": "note.get",
  "ok": true,
  "data": {},
  "error": null,
  "meta": { "transport": "http", "protocol_version": "<adapter-version>", "warnings": [] }
}
```

失败仍输出相同 envelope，`ok=false`、`data=null`，error 包含 `code`、`message`、`retryable`、`retry_after_seconds`、`action_required`、`details`。未知参数、配置失败和挑战状态损坏也必须经统一输出处理。用户动作建议是数据，不是自动执行的 shell 字符串。

JSONL 每行是带 `schema_version`、`request_id`、`type` 的合法事件：`item`、`error`、`summary`。下载进度默认只到 stderr。正常结束的流必须有 summary，包含成功/跳过/失败数量、下一 cursor 和停止原因；缺少 summary 代表流异常中断。批量允许先返回成功 item 再返回失败项，最终退出码体现部分失败。`--fields` 只投影 data/item 内的业务字段，不破坏协议 envelope。

| 退出码 | 意义 |
| --- | --- |
| 0 | 命令成功；auth start 成功创建挑战也返回 0，不代表已登录 |
| 1 | 未分类内部错误 |
| 2 | 参数、配置或模板错误 |
| 3 | 未登录或登录过期 |
| 4 | 需要用户完成验证/验证码/扫码等后续动作，当前操作不能继续 |
| 5 | 频率限制，必要时包含 retry_after_seconds |
| 6 | 网络错误、整体超时或重试耗尽 |
| 7 | 内容不可访问、已删除或不存在；不能证明原因时使用 CONTENT_UNAVAILABLE |
| 8 | 文件系统、目录权限或磁盘错误 |
| 9 | 批量部分失败 |
| 10 | HTTP 接口能力不支持或已识别的平台协议不兼容 |
| 11 | 平台明确返回列表私密或无访问权限；不能作为成功空列表 |
| 130 | 用户中断 |

建议错误码：`AUTH_REQUIRED`、`SESSION_EXPIRED`、`VERIFICATION_REQUIRED`、`CHALLENGE_EXPIRED`、`RATE_LIMITED`、`CONTENT_UNAVAILABLE`、`ACCESS_CONTEXT_REQUIRED`、`CAPABILITY_UNSUPPORTED`、`PROTOCOL_INCOMPATIBLE`、`SESSION_BUSY`、`OUTPUT_COLLISION`、`LIST_PRIVATE`、`PERMISSION_DENIED`、`RESOURCE_UNAVAILABLE`、`CURSOR_EXPIRED`、`CURSOR_CONTEXT_MISMATCH`。capabilities 返回声明能力与当前运行时状态，不将离线声明伪装成在线实测结果。

### 配套 Skill 交付要求

`skills/xhs-dl/SKILL.md` 是面向工具使用者的说明，仓库 `AGENTS.md` 是面向开发者的约定，两者分别交付。Skill 应包含：适用场景、能力发现、环境检查、非交互调用、登录交接、详情与摘要区别、搜索到详情到下载、本人/指定用户的三类列表与权限、批量/断点恢复、错误恢复、凭证处理和产物验证。命令和机器字段使用稳定英文标识，说明可用中文。

Skill 不要求读取全部帮助才能做简单任务，也不让 Agent 从网页正文接受新的工具指令。帖子标题、正文、文件名均作为不可信数据，不拼接为 shell 代码。安装位置按各 Agent 的实际 Skill 机制单独说明；本项目不自动修改全局 Agent 配置。

## 6. 登录与持久状态

推荐状态机：`anonymous → awaiting_code/awaiting_scan → awaiting_confirmation → authenticated`（短信可跳过扫码确认阶段），另有 `verification_required`、`expired`、`cancelled`、`failed`。网络失败与登录失效分开表示。

### 人在终端登录

```sh
# 输入手机号 → HTTP 发送短信 → 输入验证码 → HTTP 校验/登录 → 保存状态
xhs-dl auth login --method sms
# 也可直接传手机号，终端仅提示输入验证码
xhs-dl auth login --method sms --phone '<phone>'
# HTTP 创建二维码 → shell 显示 → 手机扫描确认 → HTTP 轮询 → 保存状态
xhs-dl auth login --method qr
```

`auth login` 专用于 TTY + human 交互；非 TTY、`--non-interactive` 或显式 JSON/JSONL 输出时，在发送请求前返回参数错误，提示改用 start/verify/wait。手机号使用普通 TTY 输入，验证码使用隐藏 TTY 输入。提示和等待状态写 stderr；最终结果按 format 输出。交互式二维码输出到 stderr 对应的终端，机器输出始终保持可解析。SSH 无需 X11、桌面或远程端口转发；用户扫描终端显示的二维码，登录进程继续在服务器运行。二维码渲染提供安静区和紧凑/标准布局，以便窄终端也能使用；可显式 `--qr-output <path>` 保存 UTF-8 字符二维码供查看，JSON 的 qr_text 则是编码前的原始扫码内容。字符画不得被颜色、进度刷新或行折叠破坏。

### Agent 分步登录

```sh
xhs-dl auth start --method sms --phone '<phone>' --format json --non-interactive
xhs-dl auth verify --challenge '<challenge-id>' --code-stdin --format json --non-interactive
xhs-dl auth status --check --format json --non-interactive

xhs-dl auth start --method qr --format json --non-interactive
xhs-dl auth wait '<challenge-id>' --timeout 120 --format json --non-interactive
```

分步流程使用**可序列化的本地登录挑战**，不保留内存中的网络会话，不启动 login worker、守护进程、IPC 服务或后台轮询：

1. start 完成匿名设备与协议初始化，通过 HTTP 发送短信或创建二维码，原子写入挑战状态后退出。
2. 挑战文件保存随机 challenge ID、profile、方法、状态、Cookie jar、设备/签名上下文、创建/到期时间，以及平台继续登录所需的二维码标识、短期 token、必要密钥材料。手机号仅在短信挑战确有需要时短期保存；验证码绝不写盘。
3. verify 加载同一个挑战状态，从 stdin 读取验证码，通过 HTTP 完成校验和登录；challenge 在扫码流程查询一次远端状态，确认后完成最终凭证交换；短信流程只返回本地阶段，不假设存在验证码投递状态接口；wait 仅在当前进程定时查询，退出后不再有轮询。
4. 成功后先原子保存账号会话，再清除临时挑战中的敏感材料；用完成标记使重复查询返回同一结果，避免重复换取凭证。挑战默认最长 5 分钟，平台返回更短期限时服从平台；到期清理在下一次命令启动时进行，不依赖后台定时器。完成标记不保留二维码密钥等敏感材料。
5. 每个 profile 同时最多一个有效登录挑战；重复 start 返回 SESSION_BUSY 与已有挑战 ID，不重复发短信。挑战 ID 限制为安全随机标识，不作为任意文件路径使用。协议状态按版本校验，缺失或不能恢复时返回 CHALLENGE_EXPIRED/PROTOCOL_INCOMPATIBLE，不另建会话继续验证。

短信发送不得由网络重试机制自动重发；发送前先持久化 sending 状态，超时且结果未知时明确提示检查手机，避免紧接着 start 再发一遍。验证码验证也不盲目重试。等待扫码/验证码是正常挑战状态，challenge 查询返回 0 和当前状态；wait 到达本地等待期限而挑战仍有效时返回退出码 4，并保留挑战供继续；内容查询遇到验证阻塞同样返回退出码 4。

遇到平台额外安全验证，若有明确可支持的 HTTP 流程则由协议层适配；否则返回 VERIFICATION_REQUIRED 和说明，保留必要状态。无论哪一种情况，都不打开验证网页或启动浏览器。

### 会话持久化与并发

- 每个 profile 保存完整 Cookie jar（domain/path/expiry/secure 等属性）、设备标识、协议上下文、必要密钥材料、用户 ID 和最后验证时间；不只保存 web_session。这些均为可序列化的本地协议数据。
- 每次恢复检查存储版本；首次网络操作必要时调用账号检查接口，响应按作用域合并 Set-Cookie。失败时不凭文件存在宣称已登录，不把网络失败直接认定为凭证过期。
- 修改会话或挑战的 HTTP 操作采用 profile 跨进程锁，覆盖加载 → 必要请求 → 原子保存，保证签名计数和 Cookie 不丢更新。等待用户输入/扫码和轮询间隔不持锁；每次请求前重读状态并校验 generation，logout/cancel 递增 generation，旧请求结果不得覆盖已失效状态。
- 不同 profile 可并行；长媒体传输在获取详情后不持会话锁。并发等待有上限，冲突返回 SESSION_BUSY。
- 配置和状态分目录：支持 `XHS_DL_CONFIG_DIR`、`XHS_DL_STATE_DIR`、`XHS_DL_CACHE_DIR`，`config path` 返回各平台实际路径。默认采用平台应用目录/XDG 约定，不把凭证放在当前项目目录。
- 凭证目录 Unix 权限 0700、文件 0600，Windows 设置对应 ACL；原子写入。首版明确是权限保护的本地凭证，不宣称已加密；不强制依赖桌面钥匙串，以支持 SSH 和最小服务器环境。
- 手机号输出掩码，验证码不写盘、不记录日志；不在 conf 存手机号/验证码/Cookie。二维码原始内容和挑战密钥按短期凭证处理，日志中脱敏。

## 7. 详情、媒体和分页模型

核心对象建议：

```ts
type NoteRef = {
  id: string;
  url?: string;
  xsec_token?: string;
  xsec_source?: string;
};
type MediaVariant = {
  url: string;
  backup_urls: string[];
  width: number | null;
  height: number | null;
  codec: string | null;
  container: string | null;
  bitrate: number | null;
  size_bytes: number | null;
  fetched_at: string;
  expires_at: string | null;
};
type Media = {
  id: string;
  index: number;
  role: 'image' | 'video' | 'live_video';
  group_id: string | null; // 同一个 Live Photo 的图片和伴随视频关联
  variants: MediaVariant[];
};
```

完整 Note 包含 ref、type、title、description、author、published_at、updated_at、tags、stats、media、fetched_at、protocol_version、completeness。时间统一为带时区 ISO 8601；无法取得的值为 null，不伪造 0、空正文或当前时间。stats 的展示字符串与可精确解析数字区分。

搜索和用户列表返回 NoteSummary，明确 `completeness=summary`，只有封面时不得伪装为完整 media。下载前必须获取 Note 详情。来源访问参数通过 NoteRef 贯穿查询、JSONL 文件和下载；纯 ID 缺必要参数时返回 ACCESS_CONTEXT_REQUIRED。

图集保持顺序；视频动态遍历各编码与档位，保留备用地址。CDN URL 可能短期有效，expires_at 未知时保持 null；下载遇到过期类响应时重新解析一次详情再按媒体身份匹配，不按旧下标盲目续传。

分页返回 `items`、`next_cursor`、`has_more`（可为 null）、`exhausted`、`stop_reason`。cursor 为版本化、不透明的本地协议值，封装 HTTP API 页游标、搜索会话标识及查询参数摘要，防止拿不同关键词/账号的 cursor 混用。记录摘要 ID 去重；重复 cursor、无新增页、平台上限、时间/页数预算分别返回明确停止原因，不能统称“全部完成”。平台原生响应 raw 可作为显式调试能力后续开放，首版不默认暴露完整请求和凭证。

## 8. 下载与文件命名

```sh
# 下载图集/视频并保存帖子元数据和正文
xhs-dl download '<note-url>' --paths './downloads' \
  -o '{author.id}/{published_at:%Y-%m}/{note.id}/{index:03}.{ext}' \
  --write-info-json --write-description --format json --non-interactive

# 先解析详情和规划目标路径，不创建下载目录、不传输媒体
xhs-dl download '<note-url>' --paths './downloads' \
  -o '{downloaded_at:%Y%m%d%H%M%S}_{note.id}/{index:03}.{ext}' --dry-run --format json

# 列出当前可访问的用户帖子，保留 NoteRef 再下载
xhs-dl user notes '<user-url>' --all --format jsonl --non-interactive > notes.events.jsonl
# Agent 提取 type=item 的 data.ref，每行写一个 NoteRef 到 refs.jsonl
xhs-dl download --input refs.jsonl --input-format jsonl --format jsonl --non-interactive
```

模板使用项目自定义的固定语法，不调用 eval、不执行 shell，也不支持任意 JS。日期采用明确文档化的 strftime 子集：`%Y` 年、`%m` 月、`%d` 日、`%H` 时、`%M` 分、`%S` 秒。用户描述的时间戳可表达为 `{downloaded_at:%Y%m%d%H%M%S}`；不直接接受语义含混的 `YyYDDHHSS`。

字段包括 `note.id/title/type`、`author.id/name`、`published_at`、`downloaded_at`、`index`、`media.id/role`、`ext`；用户来源直接下载另支持 `source.owner_id`、`source.kind`。index 从 1 开始；downloaded_at 是该次计划生成时固定的时间，重试不重新生成。模板日期默认 UTC，可用 `--timezone Asia/Shanghai` 调整。未知字段在写盘前报错；已知但缺失字段使用明确 fallback（如 `{title|untitled}`，title 作为 note.title 的别名），否则返回 TEMPLATE_VALUE_MISSING。

`--paths` 是下载根目录，允许绝对或相对路径；模板只能生成其内相对路径。变量值中的分隔符、控制字符、Windows 保留字符、尾随点/空格和超长名称规范化；模板中的固定 `/` 才表示层级。拒绝 `..`、绝对模板和经符号链接逃出根目录的写入。稳定 ID、序号和角色防止同名图集、Live Photo 相互覆盖；仍有碰撞时默认返回 OUTPUT_COLLISION，显式 `--on-exists skip|overwrite|error|rename` 控制处理。默认 error；已被下载归档验证的完整文件优先幂等跳过。

关键参数：`--media all|images|videos|live`、`--quality best|original|<height>`、`--allow-quality-fallback`、`--concurrency`、`--rate-limit`、`--resume`、`--archive`、`--write-info-json`、`--write-description`、`--dry-run`。original 仅在来源确认有原片候选时成立，不把最高转码档位标记为原片；指定条件不满足默认报错，只有显式 fallback 才降级。rate-limit 表示聚合媒体传输字节/秒，API 请求间隔另用 `--request-interval`（毫秒）。默认媒体并发 3、API 串行、请求间隔至少 1000ms，均可配置，不保证固定速率能避免限流。

下载可靠性：

1. 建立 DownloadPlan，输出每个媒体的身份、候选、最终路径和跳过原因。dry-run 允许网络解析与会话更新，但不下载、不创建输出目录或归档。
2. 同目录写 `.part`；完成长度/格式检查后原子改名。校验 Content-Type 和基本文件头，拒绝把 HTML 错误页当成媒体。
3. Range 续传校验 206、Content-Range 和 ETag/Last-Modified 等身份；服务端返回 200 或内容身份不能确认时从头开始。更换 CDN 地址后不能证明同一内容也从头开始。
4. 先切备用 CDN；识别 URL 过期后有限刷新详情；网络瞬断、429/5xx 按规则有限退避。安全挑战不自动重试，短信不进入通用重试器。
5. 归档键包含 profile、note ID、媒体稳定身份、role 和质量选择；按本地大小/摘要核对文件再跳过，不能仅以“路径已存在”认定完成。记录实际清晰度、字节数、可选 SHA-256 和完成时间。
6. `--write-info-json` 默认将访问 token、CDN 查询签名等脱敏，保留媒体属性和来源 ID；`note get` 的机器输出为了后续下载保留必要访问参数，调用者应将其作为敏感短期数据。正文单独写文本文件。
7. SIGINT 取消网络、保留可恢复 part/manifest，保存必要 HTTP 会话状态并释放锁；重新运行能区分完整、部分完成与失败。JSON 模式中断尽量输出错误 envelope；进程强杀时调用方以缺失终态判断。

短链展开与 CDN 传输均验证 URL 协议、目标主机、每次重定向及 Cookie 作用域；禁止 file/data 等 URL，不把账号 Cookie 转发给任意 CDN，也不将任意输入链接作为通用内网请求入口。

## 9. 配置契约

优先级从低到高：内置默认 → 用户配置 → 当前目录唯一项目配置 → `--config` 显式文件 → `XHS_DL_*` 环境变量 → 本次 CLI 参数。项目配置支持 `xhs-dl.conf` 或 `xhs-dl.toml`，同时存在时报错；不向父目录递归搜索。`--no-config` 跳过所有配置文件，环境变量和显式 flags 仍生效。

```toml
schema_version = 1
profile = "default"

[output]
format = "json"
color = false

[network]
request_timeout_seconds = 30
timeout_seconds = 300
retries = 2
request_interval_ms = 1000

[download]
paths = "./downloads"
template = "{author.id}/{note.id}/{index:03}_{media.role}.{ext}"
timezone = "Asia/Shanghai"
quality = "best"
concurrency = 3
resume = true
on_exists = "error"
write_info_json = true
write_description = true
```

持久参数以统一 schema 映射 flags、env、conf；help/version、短信验证码、challenge ID 等一次性操作输入不写入配置文件。挑战状态文件的临时持久化单独遵循登录章节，验证码始终不落盘。所有相对配置路径按该配置文件所在目录解析，命令行相对路径按当前工作目录解析；`config show` 返回最终值及各字段来源并脱敏。标量后者覆盖，数组整体替换，嵌套配置按字段合并，false 必须能覆盖 true；未知键及错误类型直接报错。conf 不执行 JavaScript、不展开命令替换，不隐式读取 .env。

## 10. 实施里程碑与验收

| 阶段 | 工作 | 完成标准 |
| --- | --- | --- |
| M0 可行性验证 | 在独立工作区验证 Node 本地签名、纯 HTTP 短信/扫码、跨进程挑战恢复、详情/搜索/用户发布/喜欢/收藏下一页及权限响应和下载 | 用获授权真实样本验证链路；记录环境、时间和协议版本；在无 DISPLAY 的 SSH 环境完成终端登录与下载；不能验证的能力明确标注，不用 mock 成功冒充 |
| M1 CLI 与契约 | 单包工程、配置、registry、帮助、Schema、JSON/JSONL、错误、doctor | 无登录也能离线发现能力，安装和执行不依赖图形环境；参数和配置错误遵守机器协议 |
| M2 登录与详情 | HTTP 登录、持久化 challenge、profile、锁、状态恢复、链接处理、Note/Media 归一化 | 手机号验证码及扫码真实登录，终端二维码和短信交互、分步登录跨进程验证、跨重启恢复；图文/视频/Live Photo 字段与顺序正确 |
| M3 下载 | 模板、目录、候选选择、流式写盘、续传、归档、批量摘要 | 自定义绝对/相对路径可用；重跑幂等；同名与中断恢复不损坏已有文件；过期 CDN 可有限刷新 |
| M4 发现与批量 | 搜索、me/user 资料、发布/喜欢/收藏列表、权限、分页/checkpoint 与来源直接下载 | 三类列表分别验收本人和指定用户的首屏/第二页、私密与空列表、跨账号隔离、页中截断恢复；摘要不冒充详情，部分失败保留结果；完整用例见用户模块规格 |
| M5 Agent 与发布 | Skill、离线手册、安装文档、契约检查、打包 | 干净环境可安装 tarball 并执行 CLI；新 Agent 能依文档完成登录交接到下载并核验产物 |

M0 是技术路线验证，优先核对 HTTP 登录所需状态能否完整序列化并跨进程恢复，不代表提前实现产品全部代码。若当前环境短信受限，记录具体状态并用扫码推进其他模块；短信目标仍未验收，不得将可选入口当作其完成证据。

测试分层：

- 单元/契约：配置覆盖、模板日期、跨平台文件名、路径边界、Note/Media 归一化、错误码和 Schema。
- 本地集成：可控 HTTP 服务模拟 206/200/416、连接中断、HTML 响应、过期地址、备用 CDN 和重定向；验证真实文件内容及归档，不能只看退出码。
- CLI 子进程：非 TTY 不挂起、stdout 全量可解析、stderr 不污染、未知参数也结构化、JSONL summary、SIGINT、并发 profile 锁、挑战过期/取消、重复 start 不重发短信；父进程退出后无残留子进程。
- 显式真实 E2E：用户完成验证码/扫码，验证跨重启登录、短链、图集/视频/Live Photo、搜索/用户第二页、登录过期与真实文件。凭证只在本地，网络 E2E 不作为普通 CI 必需条件。
- CI 在支持的 Node 版本和 macOS/Linux/Windows 执行 lint、typecheck、相关测试、build、打包安装；在无桌面 Linux/SSH、macOS 终端和 Windows 终端验证安装、二维码显示、短信交互与真实下载；仅声明实测支持的系统/架构组合。

完成定义：首版功能表全部实现并达到对应验收；未通过的真实平台能力在 capabilities/文档中明确为未验证或不可用。平台变更后可以替换内部 HTTP 协议适配，不需要改变稳定命令和 Note/Media 协议。

## 11. 实现基线与后续维护

当前实现遵循以下选择：单包模块化；登录、搜索、详情、用户列表和下载全部走 HTTP(S)；签名与必要加解密由本地 Node.js 完成；无浏览器、无后台服务，登录通过终端交互或可落盘的挑战状态完成；TOML 配置；模板采用固定字段与 strftime 日期子集；JSON/JSONL 是一等接口；Skill 与命令 registry 同步；第一版不要求 MCP。后续平台协议变化时，先复现对应 HTTP 请求，再修复局部适配；维护中继续保持 CLI 和数据协议的稳定性。

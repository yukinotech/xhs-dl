# xhs-dl

Node.js / TypeScript / PNPM 实现的纯 HTTP 小红书 CLI，面向终端、SSH 和 Agent。支持短信/扫码登录、帖子详情、搜索、本人/指定用户发布/喜欢/收藏列表，以及图集、视频、Live Photo 下载。

## 安装和入口

要求 Node.js 22.22.2+（22.x）、24.15+（24.x）或 26+，PNPM 12.21.0。

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js -h
node dist/cli.js -H
```

开发可用 `pnpm dev <命令>`。安装打包产物后可直接调用 `xhs-dl`；源码仓库使用 `node dist/cli.js`。

## 独立可执行文件（Bun）

独立产物包含 Bun 运行时与依赖，使用者不需要安装 Node.js、PNPM 或 Bun。Bun 仅用于构建，开发和依赖管理继续使用 Node.js / PNPM。构建机要求 Bun 1.4.4+（CI 固定 1.4.4）。

```sh
pnpm install --frozen-lockfile
pnpm build:binary                         # 当前系统和 CPU
pnpm test:binary                          # 当前平台独立运行测试
pnpm build:binary darwin-arm64 darwin-x64  # Apple Silicon / Intel macOS
pnpm build:binary windows-x64             # Windows exe
pnpm build:binary linux-x64 linux-arm64    # Linux glibc
pnpm build:binary:all                     # 全部八种目标
```

产物在 `binaries/<目标>/`，包含 `xhs-dl`（Windows 为 `xhs-dl.exe`）、`SHA256SUMS`、README、第三方许可声明、docs 和 Agent Skill。可执行文件可单独复制到其它目录；Skill 需要使用时另外保留。构建目录已加入 `.gitignore`，不会提交大文件或本地凭证。交叉编译首次可能需要联网下载对应的 Bun 运行时。

| 目标 | 系统 / CPU |
| --- | --- |
| `darwin-arm64` / `darwin-x64` | macOS Apple Silicon / Intel |
| `windows-x64` / `windows-arm64` | Windows x64 / ARM64 |
| `linux-x64` / `linux-arm64` | Linux glibc x64 / ARM64 |
| `linux-x64-musl` / `linux-arm64-musl` | Alpine 等 musl Linux x64 / ARM64 |

macOS / Linux：

```sh
./binaries/darwin-arm64/xhs-dl -H
./binaries/darwin-arm64/xhs-dl auth login --method sms
# Linux 使用对应目录；加入 PATH 后直接输入 xhs-dl
```

Windows PowerShell：

```powershell
.\binaries\windows-x64\xhs-dl.exe -H
.\binaries\windows-x64\xhs-dl.exe auth login --method sms
.\binaries\windows-x64\xhs-dl.exe download '<帖子链接>' --paths 'D:\小红书'
```

下文的 `node dist/cli.js` 均可替换为可执行文件路径。配置、登录态、参数、退出码与 Agent 输出协议相同；`doctor` / `version` 通过 `runtime` 和 `bun` 字段报告实际运行时。

GitHub Actions 的 **Standalone binaries** 工作流构建八种目标并上传产物，在 macOS ARM64 / Intel、Windows x64、Linux x64 上直接执行隔离测试和 HTTP/下载依赖测试；其它目标为交叉编译检查。Actions 的 ZIP 下载解压后，Unix 系统可能需要 `chmod +x xhs-dl`。当前本机已验证 macOS ARM64 运行，并完成 macOS Intel 交叉编译；其它平台运行验收以 CI 结果为准。产物尚未进行发布者签名或 Apple 公证，系统可能要求确认来源。

## 登录与身份

```sh
node dist/cli.js auth login --method sms
node dist/cli.js me get
node dist/cli.js auth status --check
```

按终端提示输入手机号和验证码；验证码隐藏输入，不写盘。扫码使用 `auth login --method qr`，在 shell 显示二维码后用手机小红书扫描确认。浅色终端加 `--qr-theme light`。不需要浏览器、桌面或 X11。

登录态按 profile 保存在系统应用目录，关闭终端后仍可恢复；平台过期时需要重新登录。`auth status` 只报告缓存状态，`--check` 和 `me get` 才做真实 HTTP 身份检查。`auth logout` 只清除本地当前 profile。`auth import --cookie-file <path>` 显式导入 Cookie header、JSON 数组或 Netscape 文件，验证成功才保存。

Agent 分步登录：

```sh
node dist/cli.js auth start --method sms --phone '<phone>' --format json --non-interactive
# 将验证码通过 stdin 数据传入，以 EOF 结束，不写进 shell 命令或日志
node dist/cli.js auth verify --challenge '<id>' --code-stdin --format json --non-interactive
```

QR 分步登录用 `auth start --method qr`，JSON 返回 `qr_text`，再 `auth challenge <id>` 查询一次或 `auth wait <id> --timeout 120` 等待。挑战最长 5 分钟；没有后台进程。已有挑战时继续或 `auth cancel <id>`，不会自动重复发送短信。最终凭证交换成功但身份查询失败时，可用 `auth challenge <id>` 继续身份检查。

## 用户、搜索与详情

```sh
node dist/cli.js me notes --all
node dist/cli.js me likes --limit 20
node dist/cli.js me favorites --all
node dist/cli.js user get '<用户主页或ID>'
node dist/cli.js user notes '<用户主页或ID>' --all
node dist/cli.js user likes '<用户主页或ID>' --limit 20
node dist/cli.js user favorites '<用户主页或ID>' --limit 20
node dist/cli.js user access '<用户主页或ID>' --check
node dist/cli.js search notes '风景' --type image --sort latest --limit 20
node dist/cli.js note get '<完整帖子链接、短链、分享文本或ID>'
```

喜欢指用户主动点赞的帖子，收藏指主动收藏的帖子，不是收到的互动通知。其它用户列表受当前身份权限限制；私密、未登录、验证要求和真实空列表分别返回，不绕过权限。

详情保留标题、正文、作者、时间、媒体顺序、全部已识别编码档位、备用 CDN 及实况视频。搜索/用户列表只返回摘要，每条 `ref` 保留后续详情需要的访问参数；封面不视为完整图集。纯 ID 可补 `--xsec-token`/`--xsec-source`，无法直接访问时需要完整分享链接。HTML 回退只静态解析数据，不执行网页脚本。

列表默认最多 20 条，支持 `--page-size`（最多 30）、`--cursor`、`--type`、`--max-pages` 和 `--all`。搜索排序支持 relevance/latest/likes。`--all` 仍受默认 100 页和整体 300 秒预算约束，结果明确报告是否穷尽及停止原因。

cursor 是同机状态目录中的恢复标识，24 小时有效，绑定实际账号、目标/关键词及筛选条件；页中被 limit 截断的剩余条目不会丢失。`--refresh` 与 cursor 互斥。用户列表类型筛选在本地完成，过滤空页不会直接终止分页。列表动态变化，遍历不等于事务快照。

## 下载与重命名

```sh
node dist/cli.js download '<帖子链接>' --paths './downloads' \
  -o '{author.id}/{published_at:%Y-%m}/{note.id}/{index:03}_{media.role}.{ext}' \
  --write-info-json --write-description

node dist/cli.js download --user me --source favorites --all --paths './收藏'
node dist/cli.js download --user '<用户主页>' --source posts --all
node dist/cli.js download --input refs.jsonl --input-format jsonl
node dist/cli.js download '<帖子链接>' --dry-run --format json
```

位置链接、`--input`、`--user/--source` 三种来源互斥。urls 输入格式每行一条链接；jsonl 每行一个 NoteRef（从查询事件 `item.data.ref` 提取），不是 CLI 输出 envelope。`--input -` 读取 stdin。

模板支持 `note.id/title/type`、`title`、`author.id/name`、`published_at`、`downloaded_at`、`index`、`media.id/role`、`ext`、`source.owner_id/kind`。日期使用 `%Y%m%d%H%M%S`，例如 `{downloaded_at:%Y%m%d%H%M%S}`；默认 UTC，可设 `--timezone Asia/Shanghai`。缺失字段可写 `{title|untitled}`；未知字段报错。用户来源拥有者与帖子作者分别记录。

模板生成根目录内相对路径；自动创建层级目录，清理变量中的不合法文件名字符，拒绝路径穿越、绝对模板和输出目录内的符号链接。同名默认报错，可显式 `--on-exists skip|overwrite|error|rename`。

- `--quality best|original|<height>`：图片和视频默认 best，按明确原片、详情场景、像素数及码率选择当前可用最优候选；original 只接受明确原片候选，数字要求精确高度。仅显式 `--allow-quality-fallback` 才降级。
- `--video-codec auto|h264|hevc|av1|vvc`：默认 auto 不限编码、优先画质；显式指定则只在对应编码中选最优候选，不做转码，无对应候选返回 CODEC_UNAVAILABLE。
- `--media all|images|videos|live`：live 成对下载实况图片和伴随视频。
- `--concurrency` 默认 3；`--rate-limit` 为所有媒体共享的字节/秒，0 不限；`--request-interval` 为 API 请求间隔毫秒，默认 1000。
- `.part` 与验证器用于 Range 续传；ETag/Last-Modified 不符或服务器忽略 Range 时重下。保留备用 CDN，过期地址有限刷新一次详情。
- 归档按请求质量和编码策略匹配，核对大小与 SHA-256。`best` 重跑发现更高档时升级已验证且由程序管理的文件（即使 on-exists=error）；相同或较低档跳过。用户改过的文件、没有有效归档的文件仍按冲突策略处理。
- `--write-info-json` 输出移除访问 token/CDN 查询签名的元数据；`--write-description` 保存正文。取消喜欢/收藏不会删除本地媒体。
- `--dry-run` 返回计划路径、质量和候选，不创建下载目录或归档；可进行网络解析与会话/分页状态更新。

视频详情最多进行三次 API 采样，遵循请求间隔，并合并已经观察到的编码/清晰度；图片详情保持单次请求。`resolution` 报告 api/html_fallback 来源、每次候选数与最高高度、是否波动以及警告。平台可能返回部分候选，best 表示有限采样中实际可获得的最优结果，不保证平台隐藏或未返回的原片。原因与参考项目对照见[视频画质调查](docs/video-quality-investigation.md)。

下载结果的 `media_info` 报告尺寸、编码、容器、时长、帧率和音轨；`source=file_header` 表示从本地文件头读取，`source=api` 表示规划阶段的平台元数据。无需 ffmpeg/ffprobe；文件头读取不等同于全片解码，未知字段保留 null。`codec_raw` 保留平台编码标签，EF4/EF5 分别归一化为 h264/hevc。

单帖子、单媒体完全失败时直接返回原始错误和退出码（例如 QUALITY_UNAVAILABLE/7）；批量或部分失败继续使用 PARTIAL_FAILURE/9。错误详情只保留一份 partial_result。

终端下载默认在 stderr 显示进度条，包含百分比、已下载/总大小、最近约 5 秒的平均速度和 ETA；多文件并发时合并显示。续传的已有字节计入完成比例，不计入本次速度；重试或从头下载时进度按实际文件状态重置。接收完字节后显示“校验中”，完成校验及归档后才显示“完成”。未知总大小时保留已下载大小，百分比和 ETA 显示未知。

```sh
xhs-dl download '<帖子链接>'                         # stderr 为终端时自动显示
xhs-dl download '<帖子链接>' --progress --format json > result.json
xhs-dl download '<帖子链接>' --no-progress           # 关闭进度
```

JSON/JSONL 的 stdout 结果结构保持不变，进度只写 stderr。非终端默认不显示；`--progress` 强制显示时每约两秒输出一条纯文本状态，不使用 ANSI 控制字符。`--quiet` 同时关闭等待日志和进度，优先于 `--progress`。配置项为 `[download].progress = "auto" | "always" | "never"`，环境变量为 `XHS_DL_PROGRESS`；命令行 `--progress` / `--no-progress` 覆盖配置。

## Agent、配置与诊断

机器调用显式指定 `--format json --non-interactive`；JSON stdout 为单个 envelope，JSONL 为逐条 item/error 和最后的 summary。日志、进度、二维码写 stderr。部分失败保留成功项并退出 9；无权访问退出 11；中断退出 130。`schema` 列出可导出的数据结构。

```sh
node dist/cli.js capabilities --format json
node dist/cli.js schema note --format json
node dist/cli.js config init
node dist/cli.js config show
node dist/cli.js config path
node dist/cli.js doctor --check --format json
```

TOML 配置支持 output、network、query、download；CLI 持久参数也支持对应 `XHS_DL_*` 环境变量，完整映射与默认值见 `-H`。覆盖顺序：默认 → 用户配置 → 当前目录 xhs-dl.conf/xhs-dl.toml（二者同时存在报错）→ `--config` → 环境 → CLI。`config show` 展示最终值与 sources，代理凭证脱敏；`--no-config` 只跳过文件。配置文件中的相对路径基于文件位置，CLI 相对路径基于当前目录。

`XHS_DL_STATE_DIR` / `XHS_DL_CONFIG_DIR` 可指定应用目录。macOS 默认 `~/Library/Application Support/xhs-dl`，Linux 遵循 XDG，Windows 使用 LOCALAPPDATA。凭证和短期恢复状态均在仓库外按账号隔离；Unix 目录 0700、文件 0600。Windows 应使用当前用户的受限个人目录；chmod 不等同于 Windows ACL。

[Agent Skill](skills/xhs-dl/SKILL.md) 随包提供，未自动写入全局 Agent 配置；[命令参考](skills/xhs-dl/references/commands.md) 从 CLI registry 生成，`pnpm docs:check` 检查同步。

## 验证与 Roadmap

见 [Roadmap 与验收证据](docs/roadmap.md)。2026-11-17 在当前 macOS arm64 / Node.js 22.22.2 环境已验证短信登录后的跨进程身份查询、用户三类列表及第二页、私密拒绝、搜索第二页与视频筛选/排序、完整详情、视频/图集/实况下载，以及归档重跑跳过。11 个真实媒体文件通过 ffprobe 检查。未将账号信息、原文、token 或下载产物提交到仓库。

```sh
pnpm check
pnpm format:check
pnpm docs:check
```

54项测试已在本机 Node.js 22.22.2、24.22.3、26.13.1 下全部通过。CI 配置覆盖 macOS/Linux/Windows × Node 22/24/26；远程矩阵是否通过以对应提交的 GitHub Actions 结果为准，本机验证不代表其它系统已实测。收藏夹“分组/目录”依原规格仍为待验证扩展，已实现的是收藏帖子列表。

- [完整架构](docs/architecture-plan.md)
- [用户模块规格](docs/user-content-spec.md)
- [配置示例](docs/xhs-dl.conf.example)
- [参考调研](docs/reference-research.md)、[固定快照](references-lock.json)、[协议研究来源](THIRD_PARTY_NOTICES.md)

`references/` 为只读研究快照，产品不依赖它。不要在其中修改源码、安装依赖或做登录实验。

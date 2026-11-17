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

- `--quality best|original|<height>`：best 取当前最高档，original 只接受明确原片候选，数字要求精确高度；仅显式 `--allow-quality-fallback` 才降级。
- `--media all|images|videos|live`：live 成对下载实况图片和伴随视频。
- `--concurrency` 默认 3；`--rate-limit` 为所有媒体共享的字节/秒，0 不限；`--request-interval` 为 API 请求间隔毫秒，默认 1000。
- `.part` 与验证器用于 Range 续传；ETag/Last-Modified 不符或服务器忽略 Range 时重下。保留备用 CDN，过期地址有限刷新一次详情。
- 归档按请求质量策略匹配，再核对文件大小与 SHA-256。`best` 重跑保持已有有效文件，不自动升级；显式指定另一高度并选择合适覆盖策略可重新下载。
- `--write-info-json` 输出移除访问 token/CDN 查询签名的元数据；`--write-description` 保存正文。取消喜欢/收藏不会删除本地媒体。
- `--dry-run` 返回计划路径、质量和候选，不创建下载目录或归档；可进行网络解析与会话/分页状态更新。

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

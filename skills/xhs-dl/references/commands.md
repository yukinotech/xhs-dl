# Command reference

Generated from the CLI registry. Regenerate with `pnpm docs:generate`; edit command definitions in src/cli.ts.

## xhs-dl

纯 HTTP 小红书 CLI：登录、用户列表、搜索、帖子详情与可恢复下载。

- `-V, --version`: output the version number
- `--config <path>`: 读取指定 TOML 配置文件
- `--no-config`: 不读取配置文件（环境变量和 flags 仍有效）
- `--profile <name>`: 独立账号状态名称，默认 default
- `--format <format>`: human | json | jsonl；TTY 默认 human，管道默认 jsonl
- `--fields <paths>`: 仅保留 data 中指定的逗号分隔字段（支持点路径）
- `--non-interactive`: 禁止交互输入；使用 auth start/verify/wait
- `--timeout <seconds>`: 整体超时秒数，默认 300
- `--request-timeout <seconds>`: 每个 HTTP 请求超时秒数，默认 30
- `--proxy <url>`: HTTP(S) CONNECT 代理地址
- `--retries <count>`: 下载/只读请求额外重试次数，默认 2
- `--request-interval <ms>`: 内容 API 请求最小间隔毫秒，默认 1000
- `--quiet`: 不输出等待和下载进度
- `--verbose`: 显示脱敏诊断字段
- `--no-color`: 关闭颜色（二维码始终使用无 ANSI 字符矩阵）
- `-H, --help-all`: 输出所有已实现命令、参数、登录流程与错误约定

## xhs-dl auth

纯 HTTP 登录与本地会话管理



## xhs-dl auth login

终端交互登录：短信或二维码

- `--method <method>`: sms | qr (default: sms)
- `--phone <phone>`: 手机号（不含国家代码）
- `--zone <zone>`: 国家/地区代码 (default: 86)
- `--qr-output <path>`: 保存字符二维码到新文件
- `--qr-theme <theme>`: 终端背景 dark | light (default: dark)

## xhs-dl auth start

发起可跨进程继续的登录挑战

- `--method <method>`: sms | qr
- `--phone <phone>`: 短信手机号
- `--zone <zone>`: 国家/地区代码 (default: 86)
- `--qr-output <path>`: 另存字符二维码文件
- `--qr-theme <theme>`: 终端背景 dark | light (default: dark)

## xhs-dl auth verify

从 stdin 读取验证码并完成短信登录

- `--challenge <id>`: start 返回的 challenge_id
- `--code-stdin`: 从标准输入读取验证码，需以 EOF 结束

## xhs-dl auth challenge

读取短信挑战阶段或 HTTP 查询一次扫码进度



## xhs-dl auth wait

当前进程轮询二维码直到成功或整体 timeout



## xhs-dl auth cancel

取消本地未完成登录挑战



## xhs-dl auth status

查看本地状态；check 检查真实 HTTP 登录状态

- `--check`: 访问平台确认身份

## xhs-dl auth logout

清除当前 profile 的本地会话和挑战



## xhs-dl auth import

显式导入 Cookie 文件，HTTP 验证后保存

- `--cookie-file <path>`: Cookie header、JSON 数组或 Netscape 文件

## xhs-dl me

当前实际登录账号



## xhs-dl me get

通过 HTTP 查询并更新当前登录者资料



## xhs-dl me notes

读取本人发布帖子

- `--limit <n>`: 最多返回的唯一帖子数，默认20
- `--all`: 遍历全部可见结果（仍受 timeout/max-pages 限制）
- `--page-size <n>`: 每页请求数量，1至30
- `--max-pages <n>`: 本次最多请求页数，默认100
- `--cursor <cursor>`: 继续本机同一账号和查询的分页状态
- `--refresh`: 开始新的网络查询；与cursor互斥
- `--type <type>`: all | image | video

## xhs-dl me likes

读取本人喜欢帖子

- `--limit <n>`: 最多返回的唯一帖子数，默认20
- `--all`: 遍历全部可见结果（仍受 timeout/max-pages 限制）
- `--page-size <n>`: 每页请求数量，1至30
- `--max-pages <n>`: 本次最多请求页数，默认100
- `--cursor <cursor>`: 继续本机同一账号和查询的分页状态
- `--refresh`: 开始新的网络查询；与cursor互斥
- `--type <type>`: all | image | video

## xhs-dl me favorites

读取本人收藏帖子

- `--limit <n>`: 最多返回的唯一帖子数，默认20
- `--all`: 遍历全部可见结果（仍受 timeout/max-pages 限制）
- `--page-size <n>`: 每页请求数量，1至30
- `--max-pages <n>`: 本次最多请求页数，默认100
- `--cursor <cursor>`: 继续本机同一账号和查询的分页状态
- `--refresh`: 开始新的网络查询；与cursor互斥
- `--type <type>`: all | image | video

## xhs-dl user

指定用户资料、发布、喜欢、收藏与权限



## xhs-dl user get

查看指定用户资料

- `--xsec-token <token>`: 补充链接访问 token
- `--xsec-source <source>`: 补充链接访问来源

## xhs-dl user notes

读取当前身份可见的用户posts帖子

- `--limit <n>`: 最多返回的唯一帖子数，默认20
- `--all`: 遍历全部可见结果（仍受 timeout/max-pages 限制）
- `--page-size <n>`: 每页请求数量，1至30
- `--max-pages <n>`: 本次最多请求页数，默认100
- `--cursor <cursor>`: 继续本机同一账号和查询的分页状态
- `--refresh`: 开始新的网络查询；与cursor互斥
- `--type <type>`: all | image | video
- `--xsec-token <token>`: 补充链接访问 token
- `--xsec-source <source>`: 补充链接访问来源

## xhs-dl user likes

读取当前身份可见的用户likes帖子

- `--limit <n>`: 最多返回的唯一帖子数，默认20
- `--all`: 遍历全部可见结果（仍受 timeout/max-pages 限制）
- `--page-size <n>`: 每页请求数量，1至30
- `--max-pages <n>`: 本次最多请求页数，默认100
- `--cursor <cursor>`: 继续本机同一账号和查询的分页状态
- `--refresh`: 开始新的网络查询；与cursor互斥
- `--type <type>`: all | image | video
- `--xsec-token <token>`: 补充链接访问 token
- `--xsec-source <source>`: 补充链接访问来源

## xhs-dl user favorites

读取当前身份可见的用户favorites帖子

- `--limit <n>`: 最多返回的唯一帖子数，默认20
- `--all`: 遍历全部可见结果（仍受 timeout/max-pages 限制）
- `--page-size <n>`: 每页请求数量，1至30
- `--max-pages <n>`: 本次最多请求页数，默认100
- `--cursor <cursor>`: 继续本机同一账号和查询的分页状态
- `--refresh`: 开始新的网络查询；与cursor互斥
- `--type <type>`: all | image | video
- `--xsec-token <token>`: 补充链接访问 token
- `--xsec-source <source>`: 补充链接访问来源

## xhs-dl user access

列表权限观察；check显式发起有限HTTP探测

- `--check`: 探测三类列表各一页
- `--xsec-token <token>`: 补充链接访问 token
- `--xsec-source <source>`: 补充链接访问来源

## xhs-dl note

帖子完整详情与图片/视频地址



## xhs-dl note get

解析完整链接、分享文本、短链或ID，返回完整媒体候选

- `--xsec-token <token>`: 补充链接访问 token
- `--xsec-source <source>`: 补充链接访问来源

## xhs-dl search

搜索帖子



## xhs-dl search notes

关键词搜索与可恢复分页

- `--limit <n>`: 最多返回的唯一帖子数，默认20
- `--all`: 遍历全部可见结果（仍受 timeout/max-pages 限制）
- `--page-size <n>`: 每页请求数量，1至30
- `--max-pages <n>`: 本次最多请求页数，默认100
- `--cursor <cursor>`: 继续本机同一账号和查询的分页状态
- `--refresh`: 开始新的网络查询；与cursor互斥
- `--type <type>`: all | image | video
- `--sort <sort>`: relevance | latest | likes

## xhs-dl download

下载帖子、批量输入或用户来源列表

- `--limit <n>`: 最多返回的唯一帖子数，默认20
- `--all`: 遍历全部可见结果（仍受 timeout/max-pages 限制）
- `--page-size <n>`: 每页请求数量，1至30
- `--max-pages <n>`: 本次最多请求页数，默认100
- `--cursor <cursor>`: 继续本机同一账号和查询的分页状态
- `--refresh`: 开始新的网络查询；与cursor互斥
- `--type <type>`: all | image | video
- `--xsec-token <token>`: 补充链接访问 token
- `--xsec-source <source>`: 补充链接访问来源
- `--input <file-or-dash>`: 批量输入文件；-表示stdin
- `--input-format <format>`: urls | jsonl (default: urls)
- `--user <user>`: 用户主页、ID，或me
- `--source <source>`: posts | likes | favorites，必须配合user
- `--paths <path>`: 下载根目录
- `-o, --output <template>`: 文件相对路径模板
- `--timezone <zone>`: 模板日期IANA时区，默认UTC
- `--quality <quality>`: best（默认最优）| original | 精确视频高度
- `--video-codec <codec>`: auto（默认不限编码）| h264 | hevc | av1 | vvc；只选择，不转码
- `--allow-quality-fallback`: 没有指定清晰度时允许降级
- `--no-allow-quality-fallback`: 禁止质量降级
- `--media <media>`: all | images | videos | live
- `--progress`: 强制在 stderr 显示进度；非终端输出节流纯文本
- `--no-progress`: 关闭下载进度显示
- `--concurrency <n>`: 媒体并发，默认3，最大32
- `--rate-limit <bytes-per-second>`: 聚合下载限速，0为不限
- `--resume`: 启用经身份核对的Range续传
- `--no-resume`: 从头下载
- `--archive <path>`: JSONL下载归档路径
- `--on-exists <policy>`: skip | overwrite | error | rename
- `--write-info-json`: 输出脱敏帖子元数据
- `--no-write-info-json`: 不输出帖子元数据
- `--write-description`: 输出帖子正文
- `--no-write-description`: 不输出帖子正文
- `--dry-run`: 仅解析与规划，不下载，不创建输出目录/归档
- `--no-dry-run`: 执行真实下载，覆盖配置中的dry_run

## xhs-dl config

配置与状态路径（不输出凭证）



## xhs-dl config show

显示脱敏后的有效配置



## xhs-dl config path

显示配置与账号状态目录



## xhs-dl config validate

校验已选配置文件



## xhs-dl config init

创建当前版本支持的示例配置

- `--path <path>`: 写入路径，默认用户配置目录

## xhs-dl capabilities

离线列出已实现命令与验证边界



## xhs-dl schema

列举或导出 JSON Schema；省略name列出可用结构



## xhs-dl doctor

检查运行环境和目录，check会验证HTTP登录态

- `--check`: 访问平台检查登录与网络

## xhs-dl version

输出程序与协议版本



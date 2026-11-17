# 小红书 API 与下载实现调研

本文是参考快照的历史调研记录；产品后续实施和真实验收请看 [Roadmap](roadmap.md)。

检查日期：2026-11-17。以下结论针对 `references-lock.json` 记录的 8 个提交快照，来自 README 与源码的交叉检查。仓库已实际克隆；没有安装或运行参考项目，没有登录小红书、读取用户 Cookie 或执行真实帖子下载。因此“支持”表示存在对应实现，不表示当前账号、网络下已实测可用。这些实现使用网页内部接口或页面数据，并非小红书官方承诺稳定的内容 API。

## 推荐阅读顺序

1. **JoeanAmier/XHS-Downloader**：最直接匹配“输入分享链接 → 返回图片/视频下载地址 → 可选择下载”，适合先看解析和媒体下载链路。
2. **xpzouying/xiaohongshu-mcp**：重点看扫码、登录状态检查、Cookie 保存和恢复，再看详情返回的图片/视频结构。
3. **cv-cat/Spider_XHS**：对照纯 HTTP 的二维码/短信登录、URL 到 feed 请求的转换，以及会话状态管理。
4. **NanmiCoder/MediaCrawler**：对照持久浏览器登录态、详情 API/HTML 回退和媒体候选地址处理。
5. **Andy-SoulShell/xhs-downloader**：参考已有 HTTP、MCP、SDK、下载任务的接口组织方式；它的适配层借鉴其他项目，不能视为完全独立的成功验证。

## 能力对照

“Python API”指可导入调用的方法，“HTTP API”指项目自己对外提供的服务路由。

| 本地目录 / 上游 | 帖子链接与媒体地址 | 下载入口 | 登录与状态维护 | 定位与限制 |
|---|---|---|---|---|
| `XHS-Downloader` / [JoeanAmier/XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader) | 完整/短分享链接；HTML 数据解析；图片、视频、Live Photo | HTTP `POST /xhs/detail`，`download` 开关；Python、CLI、MCP | 接受配置或请求 Cookie；当前入口未启用旧的浏览器 Cookie 读取功能；未找到完整扫码登录 API | **核心下载参考**；GPL-3.0 |
| `xiaohongshu-mcp` / [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) | 详情接口接收 `feed_id` 和 `xsec_token`；返回 `imageList`、`video.media.stream` | `POST /api/v1/feeds/detail` 与 MCP；没有找到面向任意帖子的专用媒体下载路由，需另接下载器 | 扫码、检查状态、删除 Cookie；保存/加载 Cookie 与指纹 seed | **核心登录参考**；Apache-2.0 |
| `Spider_XHS` / [cv-cat/Spider_XHS](https://github.com/cv-cat/Spider_XHS) | `get_note_info(url)`；从详情提取 `image_list`、`video_addr` | Python `download_media` / `download_note` / spider 入口；未见现成通用 HTTP 服务 | 纯 HTTP 扫码、短信、完整 Cookie 导入；Auth 对象复用 HTTP 会话与运行状态 | **协议和状态参考**；README 禁止商业化，未见根 LICENSE |
| `MediaCrawler` / [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) | URL 解析；详情 API 与 HTML 回退；图片、视频、实况媒体候选 | `ENABLE_GET_MEDIA=True` 或 CLI `--get_media true`；内部下载器 | 扫码、短信、Cookie；Playwright 持久浏览器目录；`pong()` 验证状态 | **完整链路交叉检查**；非商业学习许可证；其 WebUI API 主要是爬虫控制，不能等同单帖解析 API |
| `xhs-downloader-api` / [Andy-SoulShell/xhs-downloader](https://github.com/Andy-SoulShell/xhs-downloader) | `POST /xhs/detail`、`WorkDetail.media[].url`；HTTP/浏览器可选路由 | `download=true`、`POST /tasks`、Python SDK、MCP | `/xhs/login/qrcode`、`/xhs/login/status`、Cookie 清理；浏览器扩展或受管浏览器 | **接口设计参考**；MIT；项目较小，浏览器任务与 Cookie HTTP 是两种会话来源 |
| `xhs` / [ReaJason/xhs](https://github.com/ReaJason/xhs) | Python `get_note_by_id(id, token)`；HTML 方法；图片/视频 URL helper | 有 `download_file` 和旧 `save_files_from_note_id`，后者发现参数不一致 | 二维码创建/轮询、短信流程、requests Session；默认签名路径需要传签名回调 | **SDK 与历史协议参考**；MIT；该快照最新提交在 2025 年，有明确旧接口问题 |
| `xiaohongshu-cli` / [tamnd/xiaohongshu-cli](https://github.com/tamnd/xiaohongshu-cli) | Go `Note` / CLI `xhs note URL`；SSR 优先，登录后可回退 API；输出媒体字段 | 未找到通用媒体下载子命令/HTTP 路由，需要消费输出 URL 自行下载 | 支持传 Cookie / Cookie 文件；自动缓存的是匿名会话，不是扫码账号登录 | **轻量解析与错误语义参考**；Apache-2.0；固定编码字段可能漏新视频档位 |
| `xhs-batch-downloader` / [SamirDalem/Xiaohongshu-Batch-Downloader-Playwright-Python-Docker-Flask-API](https://github.com/SamirDalem/Xiaohongshu-Batch-Downloader-Playwright-Python-Docker-Flask-API) | Flask `POST /extract`；返回视频候选和 `video_url` | 同一接口流式下载，返回服务器 `saved_to` 路径 | 未实现小红书账号登录/持久化 | **低优先级对照**；MIT；实际自动访问 Seekin 第三方解析站，不能充当独立小红书 API 实现；未证实完整图集支持 |

## 交叉验证：链接 → 帖子 → 媒体 → 下载

### 链接和详情请求

- 保存分享链接中的 `xsec_token`、`xsec_source`；不要只提取 note ID 后丢弃查询参数。Spider_XHS、ReaJason/xhs、MediaCrawler 都将这些值用于详情请求，mcp 也要求调用方传入 token。
- 短链接需先展开跳转，最终 URL 再交给详情层。`XHS-Downloader` 有 `extract_links` 入口；并非每个 SDK 都能直接处理整个分享文本或短链。
- 直接 API 路线普遍使用 `POST /api/sns/web/v1/feed`，请求中的帖子字段是 `source_note_id`；与之独立的另一条路线是读取页面 `window.__INITIAL_STATE__` 中的 `noteDetailMap`。
- MediaCrawler 先走详情 API，失败/空数据再尝试带 Cookie 的 HTML；tamnd 项目相反，SSR 优先，仅在配置登录 Cookie 后才尝试签名 API。这样的差异适合用于设计可替换 provider。
- `xsec_token` 是帖子访问参数；`web_session` 是账号会话凭证；`a1` 等与设备/签名有关，三者不能互相替代。

### 图片与视频 CDN 字段

- 图片：HTML 通常是 `imageList[].urlDefault` 或 `infoList[].url`，API/归一化对象常为 `image_list[].url_default` / `info_list[].url`。保留图片原始顺序。不要把封面误当作完整图集。
- 视频：至少保留 `video.media.stream` 的所有档位，以及 `masterUrl` / `backupUrls`（或 snake_case 对应字段）。`originVideoKey` / `origin_video_key` 存在时，若干项目会构造原片 CDN 候选，但不能假设这个字段或固定 CDN 总存在。
- `XHS-Downloader` 会遍历 stream 下的所有列表，按分辨率/码率/大小排序；MediaCrawler 同样动态遍历，并兼容内部档位名称变化。Spider_XHS 支持常见 `h264/EF4/h265/EF5` 并遍历其他键。tamnd 的部分结构固定编码名称，适合作为遗漏情况对照。
- Live Photo 的随附视频位于图片自己的 `stream`，不一定在笔记顶层 `video`；MediaCrawler 有专门的提取函数。
- mcp 的 `VideoStream` 明确保留签名主 URL、备用地址、宽高、码率、大小等信息。带签名的地址可能过期：记录取得时间，下载失败后应允许重新获取详情，而不是把某次返回 URL 当永久链接。
- 不同实现可能选到原片、不同转码档位或不同 CDN；交叉检查时应比较 note ID、媒体数量和顺序、分辨率及文件内容，不能只要求 URL 字符串相同。

### 对外下载接口的区别

- `POST /xhs/detail` 且 `download=false`：解析详情和媒体地址；`download=true`：让服务端把媒体写到自己的文件系统。这两个实现都值得参考。
- `saved_to` 或下载产物的本地路径不等于浏览器能直接下载的 HTTP URL。若未来 xhs-dl 需要把文件返回给客户端，仍需设计文件响应/下载路由；mcp 和单纯 SDK 并未替你补齐这一层。
- Samir 的 `/extract` 依赖第三方站，且会选择候选视频并写入本地，不能据此推断它具备原生图集 API 或登录能力。

## 交叉验证：完成登录与复用登录态

### 浏览器扫码路线：优先参考 mcp 和 MediaCrawler

mcp 的 HTTP 入口是 `GET /api/v1/login/qrcode`、`GET /api/v1/login/status`、`DELETE /api/v1/login/cookies`；详情为 `POST /api/v1/feeds/detail`。这与 Andy 项目的 `/xhs/login/*` 路由及异步任务返回格式不同。

1. 启动登录页面并取得二维码，保留同一个浏览器/页面会话等待用户扫码确认；不能截图后立即销毁会话。
2. mcp 的 `GetLoginQrcode` 会在后台保留最多 4 分钟的等待流程，成功后调用 `saveCookies`。重新申请二维码会影响前一次待扫码会话，调用方应复用当前任务并轮询。
3. 将 Cookie 持久化到明确的应用状态目录。mcp 当前代码的路径优先级是 `COOKIES_PATH` → 已存在的当前目录 `cookies.json` → 旧临时路径 → 当前目录默认值；**不要照抄网上或历史 Release 对 `~/.xiaohongshu/cookies.json` 的描述**。显式指定路径更清晰。
4. 下次创建浏览器时加载 Cookie。该 mcp 快照也支持将指纹 seed 与 Cookie 一起保存；MediaCrawler 的 `SAVE_LOGIN_STATE=True` 则使用 `browser_data/<platform>_user_data_dir` 持久上下文。
5. 恢复后用真实的登录状态检查/当前用户接口确认有效性，失效再请求用户扫码。只看到文件存在或 Cookie 含 `web_session` 不足以证明仍然登录。

### 纯 HTTP 登录路线：参考 Spider_XHS，旧 xhs 作为协议对照

- Spider_XHS 的 `XHSPcAuth.from_qrcode_login()` / `from_phone_login()` 返回准备好的 Auth；`from_cookie()` 接受已有完整 Cookie 并 bootstrap 当前用户。二维码与短信方法都仍需要用户本人确认或提供验证码。
- `XHSPcAuth` 在生命周期内复用同一个 HTTP Session，维护按主机作用域划分的 Cookie、签名相关状态和计数，提供 `update_cookies`。它不是“拿到一个字符串就永久登录”的模型。
- 跨进程恢复时应由上层明确管理完整 Cookie 和必要状态的存取。这里没有把该 Auth 工厂认定为自带通用磁盘会话管理服务；需要逐项对照 `cookies`、`host_cookies_snapshot()`、`state_snapshot()` 和构造参数，后者默认会隐藏部分 token。
- ReaJason/xhs 提供二维码 create/status、短信 send/check/login 方法；但默认请求签名路径调用传入的 `external_sign`，不能把示例看作无需签名适配即可运行。
- tamnd 的 `session.json` 主要保存匿名 `a1/webId`，其源码明确不在这里生成登录 `web_session`。它提供 Cookie 导入和状态诊断，不能替代一次扫码登录。

### 登录态维持的实现边界

这些仓库提供的是保存/恢复凭证、复用会话、更新响应 Cookie、检测失效等机制；未发现能保证账号永不掉线的通用续期 API。登录过期、安全校验、账号退出或平台协议变化都需要显式返回状态并重新登录。应区分“未登录”“凭证过期”“帖子不可访问”“网络失败”，避免把所有失败都重新扫码。

## 发现的具体问题与选型依据

- **旧 SDK 下载调用不一致**：`xhs/core.py` 的 `get_note_by_id` 必需 `xsec_token`，但 `save_files_from_note_id` 内仍只传 `note_id`，在该快照会触发缺少参数错误。`get_user_all_notes` 则已传入 token，说明问题集中在旧下载封装。建议参考字段和协议，不能直接把旧下载方法当成可用实现。
- **旧浏览器 Cookie 功能已停用**：XHS-Downloader 中相关文件仍在，但导入和入口被注释；文件存在不等于当前版本启用。
- **源码优先于搜索摘要**：mcp 的 Cookie 默认路径与部分在线 Release 说明不同；以本次 commit 的代码为准。
- **成熟度不等于独立验证**：Andy 项目的接口更接近目标，但 provider/解析逻辑有上游借鉴；Samir 更是第三方解析站包装。二者不能与独立读取小红书结果混为一谈。
- **来源许可证已逐仓库记录**：见锁文件。MediaCrawler 为非商业学习许可证，Spider_XHS README 有非商业限制，XHS-Downloader 为 GPL-3.0；本次仅本地参考，没有将上游代码纳入父仓库。

## 后续端到端验证方案（本次未执行）

使用同一账号和新获取的图文、视频、Live Photo、短分享链接各一条：先对 mcp 做扫码 → 状态检查 → 重启恢复，再分别用下载器和第二个独立 provider 获取详情，核对媒体数量、顺序、清晰度、候选 URL 和下载内容。记录网络/登录/平台错误，最后模拟 Cookie 失效与 URL 过期。这才能将当前“源码存在”升级为“当前环境实测可用”。

## 固定提交的源码证据

以下链接固定到本次克隆提交，后续上游变更不会改变所引用的代码。

- `XHS-Downloader`：[HTTP 详情/可选下载路由](https://github.com/JoeanAmier/XHS-Downloader/blob/dfad51b3d1aac55866802007544f9390ad21553f/source/application/app.py#L822)（`source/application/app.py:822`）。
- `XHS-Downloader`：[图片与实况媒体提取](https://github.com/JoeanAmier/XHS-Downloader/blob/dfad51b3d1aac55866802007544f9390ad21553f/source/application/image.py#L7)（`source/application/image.py:7`）。
- `XHS-Downloader`：[原片 key 与多档视频候选](https://github.com/JoeanAmier/XHS-Downloader/blob/dfad51b3d1aac55866802007544f9390ad21553f/source/application/video.py#L7)（`source/application/video.py:7`）。
- `XHS-Downloader`：[Cookie 读取导入被注释](https://github.com/JoeanAmier/XHS-Downloader/blob/dfad51b3d1aac55866802007544f9390ad21553f/source/CLI/main.py#L24)（`source/CLI/main.py:24`）。
- `xiaohongshu-mcp`：[HTTP 登录与详情路由](https://github.com/xpzouying/xiaohongshu-mcp/blob/bb6fa2e208719ee634fec37881be29d3aa4699b3/routes.go#L48)（`routes.go:48`）。
- `xiaohongshu-mcp`：[二维码会话等待与 Cookie 保存](https://github.com/xpzouying/xiaohongshu-mcp/blob/bb6fa2e208719ee634fec37881be29d3aa4699b3/service.go#L140)（`service.go:140`）。
- `xiaohongshu-mcp`：[Cookie 路径优先级](https://github.com/xpzouying/xiaohongshu-mcp/blob/bb6fa2e208719ee634fec37881be29d3aa4699b3/cookies/cookies.go#L127)（`cookies/cookies.go:127`）。
- `xiaohongshu-mcp`：[浏览器恢复 Cookie](https://github.com/xpzouying/xiaohongshu-mcp/blob/bb6fa2e208719ee634fec37881be29d3aa4699b3/browser/browser.go#L89)（`browser/browser.go:89`）。
- `xiaohongshu-mcp`：[图片/视频/流数据结构](https://github.com/xpzouying/xiaohongshu-mcp/blob/bb6fa2e208719ee634fec37881be29d3aa4699b3/xiaohongshu/types.go#L116)（`xiaohongshu/types.go:116`）。
- `Spider_XHS`：[链接到 feed 请求](https://github.com/cv-cat/Spider_XHS/blob/23dab803a0465e35e01cf87137353a900b47e93d/apis/xhs_pc_apis.py#L513)（`apis/xhs_pc_apis.py:513`）。
- `Spider_XHS`：[图片视频 URL 提取](https://github.com/cv-cat/Spider_XHS/blob/23dab803a0465e35e01cf87137353a900b47e93d/xhs_utils/data_util.py#L69)（`xhs_utils/data_util.py:69`）。
- `Spider_XHS`：[媒体下载](https://github.com/cv-cat/Spider_XHS/blob/23dab803a0465e35e01cf87137353a900b47e93d/xhs_utils/data_util.py#L218)（`xhs_utils/data_util.py:218`）。
- `Spider_XHS`：[三种登录 Auth 工厂](https://github.com/cv-cat/Spider_XHS/blob/23dab803a0465e35e01cf87137353a900b47e93d/xhs_utils/xhs_pc/auth.py#L438)（`xhs_utils/xhs_pc/auth.py:438`）。
- `Spider_XHS`：[Cookie 和运行状态维护](https://github.com/cv-cat/Spider_XHS/blob/23dab803a0465e35e01cf87137353a900b47e93d/xhs_utils/xhs_pc/auth.py#L294)（`xhs_utils/xhs_pc/auth.py:294`）。
- `MediaCrawler`：[详情 API 到 HTML 回退](https://github.com/NanmiCoder/MediaCrawler/blob/4d629b52eddef9c53b5e9a52b76ec4a64383b494/media_platform/xhs/core.py#L289)（`media_platform/xhs/core.py:289`）。
- `MediaCrawler`：[浏览器持久登录目录](https://github.com/NanmiCoder/MediaCrawler/blob/4d629b52eddef9c53b5e9a52b76ec4a64383b494/media_platform/xhs/core.py#L429)（`media_platform/xhs/core.py:429`）。
- `MediaCrawler`：[视频图片与 Live Photo 候选](https://github.com/NanmiCoder/MediaCrawler/blob/4d629b52eddef9c53b5e9a52b76ec4a64383b494/media_platform/xhs/media.py#L77)（`media_platform/xhs/media.py:77`）。
- `MediaCrawler`：[登录状态与扫码/短信/Cookie](https://github.com/NanmiCoder/MediaCrawler/blob/4d629b52eddef9c53b5e9a52b76ec4a64383b494/media_platform/xhs/login.py#L52)（`media_platform/xhs/login.py:52`）。
- `MediaCrawler`：[下载开关](https://github.com/NanmiCoder/MediaCrawler/blob/4d629b52eddef9c53b5e9a52b76ec4a64383b494/config/base_config.py#L111)（`config/base_config.py:111`）。
- `xhs-downloader-api`：[详情与下载响应](https://github.com/Andy-SoulShell/xhs-downloader/blob/cc2bb34036acb12f5a722c95af7bad53ec696d03/apps/api/src/xhs_api/posts.py#L31)（`apps/api/src/xhs_api/posts.py:31`）。
- `xhs-downloader-api`：[登录二维码任务路由](https://github.com/Andy-SoulShell/xhs-downloader/blob/cc2bb34036acb12f5a722c95af7bad53ec696d03/apps/api/src/xhs_api/login.py#L39)（`apps/api/src/xhs_api/login.py:39`）。
- `xhs-downloader-api`：[登录状态任务路由](https://github.com/Andy-SoulShell/xhs-downloader/blob/cc2bb34036acb12f5a722c95af7bad53ec696d03/apps/api/src/xhs_api/browser_operations.py#L55)（`apps/api/src/xhs_api/browser_operations.py:55`）。
- `xhs-downloader-api`：[媒体 URL 模型](https://github.com/Andy-SoulShell/xhs-downloader/blob/cc2bb34036acb12f5a722c95af7bad53ec696d03/packages/xhs-core/src/xhs_core/domain/models.py#L69)（`packages/xhs-core/src/xhs_core/domain/models.py:69`）。
- `xhs`：[必需 token 的详情签名](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L206)（`xhs/core.py:206`）。
- `xhs`：[旧下载方法漏传参数](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L309)（`xhs/core.py:309`）。
- `xhs`：[二维码和短信接口](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L648)（`xhs/core.py:648`）。
- `xhs`：[外部签名回调](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L135)（`xhs/core.py:135`）。
- `xhs`：[媒体 URL 与流式下载 helper](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/help.py#L104)（`xhs/help.py:104`）。
- `xiaohongshu-cli`：[SSR 优先与 API 回退](https://github.com/tamnd/xiaohongshu-cli/blob/b60f9a384ed32d002aaacbbff95fedb2bdc96682/xiaohongshu/note.go#L88)（`xiaohongshu/note.go:88`）。
- `xiaohongshu-cli`：[匿名会话持久化边界](https://github.com/tamnd/xiaohongshu-cli/blob/b60f9a384ed32d002aaacbbff95fedb2bdc96682/xiaohongshu/session.go#L17)（`xiaohongshu/session.go:17`）。
- `xiaohongshu-cli`：[Cookie 与文件导入](https://github.com/tamnd/xiaohongshu-cli/blob/b60f9a384ed32d002aaacbbff95fedb2bdc96682/cli/root.go#L74)（`cli/root.go:74`）。
- `xhs-batch-downloader`：[第三方解析站地址](https://github.com/SamirDalem/Xiaohongshu-Batch-Downloader-Playwright-Python-Docker-Flask-API/blob/f1b1185a32defc209927d2d5de1128e92529fba8/app_playwright_update.py#L16)（`app_playwright_update.py:16`）。
- `xhs-batch-downloader`：[提取与本地下载接口](https://github.com/SamirDalem/Xiaohongshu-Batch-Downloader-Playwright-Python-Docker-Flask-API/blob/f1b1185a32defc209927d2d5de1128e92529fba8/app_playwright_update.py#L204)（`app_playwright_update.py:204`）。

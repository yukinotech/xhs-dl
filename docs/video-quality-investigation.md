# 视频候选、默认画质与下载结果优化

日期：2026-11-17。以下是同一授权视频、同一登录 profile、直连 HTTP 环境下的实测结论；未记录真实账号、访问 token 或签名 CDN 地址。

## 候选不一致的原因

问题发生在 JSON API 原始响应中，不是媒体数组遍历遗漏，也不是两次调用分别走 API 和静态页面造成的差异。对 `/api/sns/web/v1/feed` 使用相同请求体，连续三次成功响应的候选数为 **4、1、4**。完整响应包含 EF4 的一档和 EF5 的三档；稀疏响应的 EF5 字段仍然存在，但值为 **空数组**。

完整候选对应：

| 平台桶 | 标准编码 | 尺寸 |
| --- | --- | --- |
| EF4 | h264 | 720×1280 |
| EF5 | hevc | 720×1280 |
| EF5 | hevc | 1080×1920 |
| EF5 | hevc | 1440×2560 |

因此，该 API 并非固定只支持 720 宽度，而是单次成功响应未必包含全部可用编码和档位。程序此前将一次成功结果当作完整候选集，是可靠性上的不足；平台为何在某次请求中返回空 EF5 桶，客户端无法观察其内部决策，不能据此宣称具体的分流、实验或风控原因。

## 与锁定参考快照的对照

- `references/Spider_XHS/apis/xhs_pc_apis.py:get_note_info` 的详情请求体与本项目相同，包含 source_note_id、image_formats、extra.need_body_topic、xsec_source、xsec_token，没有额外的“请求所有视频清晰度”参数。
- `references/xhs/xhs/core.py:get_note_by_id` 和 `references/xiaohongshu-cli/xiaohongshu/note.go:noteAPI` 使用相同接口和同类参数；need_body_topic 的值分别使用数字和布尔值，本项目与 Spider_XHS 使用字符串。没有证据表明该话题正文参数控制视频编码。
- Spider_XHS 还发送 feed 分片头 `xy-direction`。本项目此前未对齐该头，本次已补齐有用户 ID 时的 feed/homefeed 头，其计算由合成向量验证。额外 12 次交错对照中，带头和不带头均出现过 EF5 空数组，因此补齐它不能保证候选齐全。样本量不足以证明它完全不影响返回频率。
- `references/Spider_XHS/xhs_utils/data_util.py` 明确识别 EF4/H.264、EF5/H.265，并优先选择 H.264 的第一个可用地址。这是兼容性策略，不能用作本项目“默认最优画质”的选择策略。
- `references/XHS-Downloader/source/application/video.py` 动态遍历 stream 编码桶，再按分辨率、码率或大小选择。本项目已经动态遍历桶，本次继续保留，补上编码标签归一化和候选补全。
- Go 参考项目采用 SSR 优先和固定 h264/h265/h266/av1 字段。固定字段可能漏掉 EF4/EF5 这样的新桶，本项目不改为固定白名单解析。

本次前置调查共 15 次原始 API 观察（含最初三次）：9 次四档、6 次一档；均为 HTTP 200、平台 code=0/success=true。静态页面对照未能取得可解析的对应详情，不作为“最高画质替代源”的证据。

## 实现行为

1. 图片详情单次请求；视频详情最多三次串行采样，遵循 request-interval、整体 timeout，合并同一媒体的已观察候选。后续较少的候选不会删除先前的高清档；遇登录、权限、限流或安全挑战立即停止。
2. `resolution` 提供 api/html_fallback 来源、每次候选数与最高高度、实际请求次数、是否变化及警告。best_effort=true 明确有限采样不保证穷尽平台未返回的档位。
3. 图片和视频默认 `quality=best`；优先明确原片、详情场景，再比较像素数及码率。默认 video_codec=auto，不为兼容性静默牺牲清晰度。显式 `--video-codec h264|hevc|av1|vvc` 只筛选，不转码。
4. `codec` 输出标准名称；`codec_raw` 保留平台标签，未知桶继续保留。
5. `media_info` 报告文件头中的容器、编码、宽高、时长、平均帧率和音轨。读取有大小边界，不依赖外部 ffmpeg/ffprobe；source=file_header 与 dry-run 的 source=api 分开。未知或不支持的字段保持 null，文件头检查不等于全片解码。
6. best 重跑发现更高档时升级已通过大小和 SHA-256 核对的程序管理文件；相同或较低档跳过，不覆盖用户改过的内容。
7. 单帖子单媒体完全失败时保留原始错误分类，例如 QUALITY_UNAVAILABLE/7、CODEC_UNAVAILABLE/7；批量或部分失败继续返回 PARTIAL_FAILURE/9。JSON 和 JSONL 一致，错误详情只保留一份 partial_result。

## 复测与边界

本机 macOS ARM64 独立可执行文件在没有传 quality/video-codec 参数、禁用配置文件且清除代理环境的条件下，默认选择并下载 1440×2560、60fps、约 63.112 秒的 HEVC/AAC MP4。程序输出的文件头信息与外部 ffprobe 一致，SHA-256 匹配，ffmpeg 全片解码通过。重复执行跳过已有同档文件。H.264 筛选计划选择 720×1280；原片不可用时 JSON 和 JSONL 均直接返回 QUALITY_UNAVAILABLE/7。

合成回归覆盖稀疏 API 响应合并、权限/限流停止、静态回退标记、编码筛选、像素数排序、图片详情场景、已验证文件升级与用户文件保护，以及有界 MP4/图片文件头读取。本轮不代表已在其它操作系统验证新增行为，也不保证未返回的更高档、原片或平台长期接口稳定性。

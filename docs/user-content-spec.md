# 用户资料、发布、喜欢与收藏：详细功能设计

日期：2026-11-17。状态：拟实现契约，本人/指定用户资料、发布/喜欢/收藏列表、分页恢复、权限结果与来源下载已实现，并完成授权会话下的代表性实测，详情见 roadmap。继承 [架构方案](architecture-plan.md) 的纯 HTTP、Node.js / TypeScript / PNPM、SSH 与 Agent 优先约束。

## 1. 功能边界和对象

“喜欢”统一指用户主动点赞的帖子，命令用 `likes`；“收藏”指用户主动收藏的帖子，命令用 `favorites`。两者均不指该用户收到的互动通知，也不表示执行点赞/收藏动作。

第一版必需交付：

| 内容 | 当前登录者 | 指定用户 |
| --- | --- | --- |
| 基本资料 | 查询并校验实际登录身份 | 查询当前身份可见资料 |
| 已发布帖子 | 分页/遍历当前可见的本人已发布内容 | 分页/遍历当前身份可见的目标用户已发布内容 |
| 喜欢的帖子 | 分页/遍历本人喜欢列表 | 当前身份获准查看时分页/遍历 |
| 收藏的帖子 | 分页/遍历本人收藏列表 | 当前身份获准查看时分页/遍历 |
| 查看详情/下载 | 对列表中每条可访问帖子执行 | 对列表中每条可访问帖子执行，权限逐条判断 |

本人身份不意味着所有接口无条件可用；登录过期、挑战和协议不兼容必须单独呈现。本人发布列表不包含草稿管理，不承诺提供只有创作者后台才有的内容。其他用户列表的权限以平台对当前会话的响应为准，不根据是否关注、主页计数或列表名称猜测。

## 2. 命令表和用户身份

| 命令 | 行为 |
| --- | --- |
| `xhs-dl me get` | 调用 HTTP 当前用户接口，返回真实登录者资料 |
| `xhs-dl me notes` | 列举当前登录者发布的帖子 |
| `xhs-dl me likes` | 列举当前登录者喜欢的帖子 |
| `xhs-dl me favorites` | 列举当前登录者收藏的帖子 |
| `xhs-dl user get <url-or-id>` | 查询指定用户资料 |
| `xhs-dl user notes <url-or-id>` | 列举指定用户发布的帖子 |
| `xhs-dl user likes <url-or-id>` | 尝试读取指定用户喜欢列表，无权时明确失败 |
| `xhs-dl user favorites <url-or-id>` | 尝试读取指定用户收藏列表，无权时明确失败 |
| `xhs-dl user access <url-or-id> [--check]` | 返回三类列表权限观察；check 对未知/过期观察进行最小 HTTP 请求 |

`me` 命令全部要求有效登录，不能从 conf、昵称或历史 profile 标签推断账号。指定用户查询沿用当前 `--profile` 的 HTTP 会话；可匿名访问的资料/发布列表允许匿名查询，喜欢/收藏按接口实际要求认证，不通过换账号或切换匿名方式规避已返回的拒绝。

`UserRef` 保留 `id`、`url`、`xsec_token`、`xsec_source`。用户主页 URL 的访问参数用于用户接口；每条帖子的 NoteRef 使用列表实际返回的帖子访问参数，不能把主页 token 填进所有帖子。`--xsec-token`、`--xsec-source` 作为 user 命令的显式补充输入。

`user access` 无 check 时不发出新的请求，返回当前会话下已有观察或 unknown；未知是正常状态。check 默认最多探测 posts/likes/favorites 各一页，复用该次已取得的数据；遇登录失效、限流、安全挑战即停止剩余探测。探测到部分条目只能说明此刻该列表可读，不能证明之后每页、每条详情均可读。该命令成功报告 denied 仍返回退出码 0；实际列表命令遇 denied 则返回权限错误。

资料返回字段至少包括：

- `ref`、`nickname`、`red_id`、`bio`、`avatar_url`、`profile_url`、`is_self`、`fetched_at`。
- `counts.posts/followers/following`，以及平台若提供的 `counts.received_likes_and_favorites`；未知为 null，近似展示数保留 display 值并标注 approximate。
- `list_access.posts/likes/favorites` 使用下文的 ListAccess；资料接口没有明确权限证据时保持 unknown，不能为了补全资料默认请求所有私密列表。

`received_likes_and_favorites` 是该用户收到的互动统计，不是其主动喜欢/收藏的帖子数量。列表另返回 `reported_total`（平台确实提供时）和本次实际 emitted 数量，不能用主页统计推算列表应有多少条，或用计数对不上判定缺页。

## 3. 参数、分页和完整性

六种列表命令使用同一契约：

- `--limit <n>`：最多返回 n 个唯一帖子，默认 20，必须为正整数。
- `--all`：持续请求到明确穷尽或触及预算；与显式 limit 互斥，不代表可以突破平台限制。
- `--page-size <n>`：单页建议数量；按接口允许范围校验，记录实际取回数量。
- `--cursor <value>`：继续相同列表查询，绑定实际查看者、目标用户、列表类别、筛选条件、协议版本和有效期。
- `--max-pages <n>` / `--timeout <seconds>`：约束当前调用，默认最多 100 页、整体 300 秒；达到预算返回 `exhausted=false` 和可继续 cursor（若可用），不标记为全部完成。
- `--type all|image|video`：列表侧筛选；若接口不支持则在本地筛选，并明确报告 `filter_mode=local`。Live Photo 归属图文，类型未知的卡片不能误判为视频。
- `--format human|json|jsonl`、`--fields`、`--non-interactive`：继承统一 Agent 输出契约。

列表保持服务端顺序，`order=platform_default`；只有接口实际支持且适配层验证后才增加其它排序值。不能根据帖子发布时间推断喜欢/收藏发生时间，也不能假设喜欢/收藏列表必定按该行为时间降序排列。

分页实现要求：

1. 第一页、下一页逐页请求并校验响应结构；先收集本页再判断 has_more，不能因 cursor 缺失直接丢掉最后一页。
2. `--limit` 针对筛选和去重后的有效条目，另外记录 fetched/filtered/duplicate/unavailable 数量。接口缩小 page-size 不等于结束；本地筛选得到空页也不等于结束。
3. note ID 用于同一列表遍历去重；置顶帖跨页重复要跳过但不阻止继续。无新增内容可做有限次探测，不能无界循环；停止时用 no_progress，不伪装为 exhausted。
4. 每页处理完成保存 checkpoint；遇 limit 截断于页中时，保存尚未输出的卡片和后续平台 cursor，下一次先输出待消费条目。直接返回下一页游标会漏掉本页剩余内容，禁止这样实现。
5. 公开 cursor 可引用权限受限的本地 checkpoint，不包含明文凭证；不能作为任意文件路径。支持继续调用不等于跨机器可移植，帮助中明确 cursor 依赖相同状态目录及账号。更换账号/目标/列表或参数不匹配时返回 CURSOR_CONTEXT_MISMATCH；文件丢失/到期返回 CURSOR_EXPIRED。
6. checkpoint 保存遍历所需的已见 ID；查询缓存、权限观察、待消费页按实际查看者隔离。账号检查后才消费本人敏感缓存；复用缓存不代表重新获得远端权限，需标注 fetched_at/from_cache，可用 `--refresh` 强制重新请求当前页。refresh 与 cursor 组合拒绝，避免混合旧待消费页和新查询。
7. `has_more=false` 才能声明平台报告穷尽；未知响应、重复 cursor、权限变化、请求失败或平台上限均有独立 stop_reason。私密列表返回空数组但缺少明确成功/分页语义时标记 unknown，不认定“没有收藏”。
8. 喜欢和收藏会变化，遍历只代表一次尽力而为的观察，不是平台事务快照；summary 标注 `consistency=best_effort`，不承诺分页过程中绝不遗漏变化条目。

## 4. 权限结果和错误语义

权限信息针对 **viewer × target × list-kind**，不是账号全局开关。

```ts
type UserListKind = 'posts' | 'likes' | 'favorites';
type ListAccess = {
  state: 'allowed' | 'denied' | 'unknown';
  reason: 'self' | 'api_allowed' | 'private' | 'forbidden' | 'undetermined';
  checked_at: string | null;
  evidence: 'api_response' | 'cached_observation' | 'none';
};
```

即使目标是本人，也必须取得有效成功响应才能设 allowed；不能仅凭 `viewer.id === target.id` 赋予权限。allowed 只表示本次接口响应允许读取，reason=self 描述关系，不承诺整个账号的其它能力。

| 场景 | 列表结果 | 退出码 / 错误码 |
| --- | --- | --- |
| 已验证的可读空列表 | items=[]、allowed、exhausted=true | 0 |
| 目标明确关闭喜欢/收藏可见性 | denied、reason=private，不能包装成成功空列表 | 11 / LIST_PRIVATE |
| 平台明确禁止当前身份访问 | denied、reason=forbidden | 11 / PERMISSION_DENIED |
| 未登录或会话过期 | 不将其归类为目标隐私设置 | 3 / AUTH_REQUIRED 或 SESSION_EXPIRED |
| 安全验证或限流 | 保留已取得结果，不自动换身份重试 | 4 / VERIFICATION_REQUIRED，或 5 / RATE_LIMITED |
| 平台只返回无法确定原因的不可访问 | unknown，保留脱敏诊断，不推断用户隐藏了列表 | 7 / RESOURCE_UNAVAILABLE |
| HTTP 协议不兼容/适配能力缺失 | 不解释为列表私密 | 10 / PROTOCOL_INCOMPATIBLE 或 CAPABILITY_UNSUPPORTED |
| 无效/不匹配的本地 cursor | 请求前报错，不重新从头抓取 | 2 / CURSOR_EXPIRED 或 CURSOR_CONTEXT_MISMATCH |

不能把任意 HTTP 403 都映射为私密：联合平台错误码、响应结构、登录检查结果和验证头分类。无法证明原因时保留 unknown。用户资料能读不代表喜欢或收藏能读，列表能读不代表其中每篇内容能读。

查询中途权限收回或其它请求失败：保留已获得的合法结果，`exhausted=false`。有结果时以退出码 9 表示部分失败，summary 记录 `terminal_error` 和原始分类（如 LIST_PRIVATE/11）；没有结果则使用原始错误退出码。JSON 模式用 `ok=false`、`data=null`，已取得 items 与分页状态放在 `error.details.partial_result`；JSONL 已发出的 item 不撤回，随后输出 error 和 summary。达到用户 limit/预算是成功的有限查询，返回 0 及未穷尽状态。

## 5. 返回结构和内容身份

列表查询的 JSON envelope 的 data 结构：

```json
{
  "viewer": { "id": "synthetic-viewer", "authenticated": true },
  "target": { "id": "synthetic-owner", "is_self": false },
  "kind": "favorites",
  "access": {
    "state": "allowed",
    "reason": "api_allowed",
    "checked_at": "2026-11-17T06:00:00Z",
    "evidence": "api_response"
  },
  "items": [
    {
      "ref": { "id": "synthetic-note", "xsec_token": "synthetic-access-token" },
      "title": "合成示例标题",
      "author": { "id": "synthetic-author", "name": "合成作者" },
      "type": "image",
      "completeness": "summary",
      "availability": "available",
      "list_context": {
        "owner_id": "synthetic-owner",
        "kind": "favorites",
        "relation_at": null,
        "observed_at": "2026-11-17T06:00:00Z"
      }
    }
  ],
  "page": {
    "next_cursor": "synthetic-checkpoint-id",
    "has_more": true,
    "exhausted": false,
    "stop_reason": "limit",
    "order": "platform_default",
    "consistency": "best_effort"
  },
  "counts": { "emitted": 1, "fetched": 1, "duplicates": 0, "filtered": 0, "unavailable": 0 }
}
```

匿名 viewer 的 id 为 null。卡片 availability=available 仅表示列表给出正常可用卡片，不保证详情请求成功；列表已明确标记删除/不可访问时可为 unavailable，未提供足够信息为 unknown。没有 note ID 的占位条目只计入 unavailable，不虚构 NoteRef。可识别 ID 的失效条目返回最小摘要并保留其状态，计入 emitted 和 unavailable；标题或作者未知用 null，不能编造。JSONL 每个 item 的 data 与 items 元素相同，summary 包含 viewer/target/kind/access/page/counts。

`list_context.owner_id` 是执行点赞/收藏的人；`author.id` 是帖子的作者，两者不能混用。`relation_at` 只有接口提供明确行为时间才填写，未知为 null；`observed_at` 是抓取时间，不替代行为时间。完整详情及媒体只由 `note get` 获取；禁止把收藏卡片封面作为完整图集下载。

权限观察和用户列表缓存默认只在当前调用内复用，不持久缓存完整列表；为 cursor 保存的 checkpoint 是显式恢复状态。后续若增加跨调用缓存，必须提供 TTL、refresh、账号隔离和来源时间。`user access` 可复用同一次调用的响应或带时间的本地检查观察，不能声称它是实时授权承诺。

## 6. 查看详情和批量下载

列表命令只查询；显式 download 才下载。新增下载来源入口：

```sh
# 本人的收藏和喜欢
xhs-dl me favorites --all --format jsonl --non-interactive
xhs-dl me likes --limit 50 --format json --non-interactive

# 指定用户三种内容
xhs-dl user notes '<user-url>' --all --format jsonl --non-interactive
xhs-dl user likes '<user-url>' --limit 20 --format json --non-interactive
xhs-dl user favorites '<user-url>' --limit 20 --format json --non-interactive

# 本人收藏直接下载
xhs-dl download --user me --source favorites --all --paths './my-favorites' \
  --write-info-json --format jsonl --non-interactive

# 按目标用户发布列表下载
xhs-dl download --user '<user-url>' --source posts --all --paths './creator-posts' \
  --format jsonl --non-interactive
```

`--user me` 是保留值，绑定当前真实登录账号。`--user` 必须与 `--source posts|likes|favorites` 同时出现；此组参数与位置链接、`--input` 互斥。此模式复用列表 limit/page-size/all/max-pages/cursor/type/refresh 契约和权限判断，不维护第二套分页器。整体 timeout 包括身份检查、列表请求、详情和媒体传输。

处理管线：解析 viewer/target → 查询列表 → 保留来源关系 → 获取每帖完整详情 → 规划媒体 → 下载 → 输出汇总。边分页边消费，以有界队列控制内存；列表有权读取才请求内容，不拿 profile 缓存跨账号补结果。

- 默认去重到 note/media 级别，已下载的相同媒体按归档规则跳过；同一帖子同时出现在喜欢和收藏时仍保留两份来源关系，不必重复保存媒体。
- 清单将 source owner/kind、帖子 author、选用的媒体质量、产物路径和失败原因分别记录。查询“甲收藏的乙的帖子”时，目录的 author 仍是乙。
- 可选模板字段 `source.owner_id`、`source.kind` 供用户按来源分类；不是用户列表来源时为缺失值，按模板 fallback 规则处理。
- 列表失效卡片默认跳过并记录 unavailable，summary 明确 skipped_unavailable；已可用卡片在详情/下载阶段失败则计 failed，继续处理其它内容，最终退出码 9。整份列表无权访问时返回 11，不写成“下载 0 条成功”。
- 帖子取消喜欢/取消收藏不会自动删除本地媒体；这不是双向同步工具。
- 列表恢复 checkpoint 与下载 manifest 分开：某一页已列出不代表已下载。只有条目已进入持久 manifest 或产生终态结果后才提交消费位置，避免中断后跳过尚未下载的帖子。

Agent 也可先保存查询输出，取 JSONL item.data.ref，再调用既有 `download --input refs.jsonl --input-format jsonl`。此路径仅保留 NoteRef，若需保留来源关系应使用直接列表下载或另存来源清单。

## 7. 收藏夹分组的能力边界

“收藏帖子列表”和“收藏夹目录/分组”是两种能力。本轮核对的 HTTP 代码提供了收藏列表入口，但没有确认可用的收藏夹目录、成员分页及分组权限协议。因此：

- 收藏帖子查询与下载列为第一版必需功能，不因收藏夹能力未证实而延后。
- 收藏夹分组列为待验证扩展，`capabilities` 分别报告 favorites_list 和 favorite_folders 的实现/验证状态。
- 不预先发布可用的 folders 命令或 `--folder` 参数，不把本地按作者分目录冒充远端收藏夹。
- 后续验证 HTTP 接口后，再补充收藏夹 ID/名称、拥有者、可见性、成员分页、重复归属和下载映射的独立设计。

## 8. HTTP 参考证据与模块接口

以下是固定本地快照中的实现线索，不是小红书官方稳定 API 承诺，尚未证明当前账号线上可用：

| 功能 | 源码中的 HTTP 路径 | 主要来源 |
| --- | --- | --- |
| 当前登录者 | `/api/sns/web/v2/user/me` | Spider_XHS `get_user_me` |
| 用户发布 | `/api/sns/web/v1/user_posted` | Spider_XHS `get_user_note_info` |
| 用户喜欢 | `/api/sns/web/v1/note/like/page` | Spider_XHS `get_user_like_note_info`；ReaJason/xhs `get_user_like_notes` |
| 用户收藏 | `/api/sns/web/v2/note/collect/page` | Spider_XHS `get_user_collect_note_info`；ReaJason/xhs `get_user_collect_notes` |

源码见 [Spider_XHS 用户 API](../references/Spider_XHS/apis/xhs_pc_apis.py) 和 [ReaJason/xhs SDK](../references/xhs/xhs/core.py)，固定提交见 [快照清单](../references-lock.json)。`/api/sns/web/v1/you/likes` 是互动通知线索，不用于实现用户喜欢/收藏列表。mcp 中的主页 tab 仅用作语义交叉检查，不引入其浏览器执行路径。

内部使用 `ResolveViewer`、`ResolveUserRef`、`GetUser`、`ObserveListAccess`、`ListUserNotes(kind)`、`DownloadUserNotes(kind)`。HTTP 层分别实现 posted/liked/collected 请求；应用层复用 paginator、summary normalizer 和 download planner。权限判断属于请求结果处理，不单独发一轮预检才能列举，避免重复首屏请求；user access 是可选诊断入口。

## 9. 实施与验收要求

实施顺序：真实 viewer 解析与 UserRef → 发布/喜欢/收藏三个 HTTP 适配 → 权限与错误归一化 → 分页/checkpoint → me/user 命令 → 详情与直接下载 → Skill/帮助和端到端核验。三种列表按独立能力报告，不能以发布列表成功代替收藏列表验收。

必须覆盖：

1. 本人资料和三类列表各自首屏、第二页、末页；本人喜欢与收藏跨进程恢复后仍归属正确账号。
2. 指定用户发布列表、多页重复置顶、末页无 cursor 但含条目；明示平台终止与预算终止不混淆。
3. 对已明确开放的目标读取喜欢/收藏，对明确关闭的目标返回 LIST_PRIVATE；若没有获授权的真实样本，则该可见性场景保持未验证。
4. 可读空列表、私密、登录失效、安全挑战、限流、网络失败和协议错误分别处理，不能统一返回空数组或 403=私密。
5. 列表中途权限撤销时保留已输出结果，summary/JSON partial_result 与退出码一致；user access 报告拒绝与列表命令失败的退出码语义不同。
6. limit 在页中截断后恢复不漏剩余条目；筛选空页可继续；重复 cursor/无进展受限停止；过期 cursor、换 target/kind/账号时明确拒绝。
7. 两个 profile 指向不同账号，以及同一 profile 重新登录另一账号时，私密缓存、访问观察与 checkpoint 均不串用。
8. 来源拥有者与实际作者不同、喜欢/收藏行为时间未知、失效卡片、同帖多来源均正确表示；摘要不会作为完整图集。
9. 三种来源都可明确请求批量下载；重复执行幂等，中断后 manifest 与分页 checkpoint 不丢未处理条目；取消收藏不删本地文件。
10. 帮助、capabilities、Schema 和 Skill 同步展示全部 me/user 命令、权限退出码及待验证的收藏夹能力；全部操作在纯 HTTP、无桌面 SSH 环境完成。

普通 CI 使用合成响应测试权限/分页/隔离与本地 HTTP 传输；真实 E2E 使用用户授权账号及样本，记录时间与协议版本，不提交真实收藏、喜欢清单、访问 token 或下载内容。

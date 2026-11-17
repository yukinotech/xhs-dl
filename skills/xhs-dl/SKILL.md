---
name: xhs-dl
description: Use the HTTP-only xhs-dl CLI to authenticate to Xiaohongshu, inspect posts, search, list accessible posted/liked/favorited notes, and download images, videos or Live Photos from a terminal or Agent.
---

# xhs-dl

Use installed `xhs-dl`, or `node dist/cli.js` from a built checkout. It runs over HTTP on terminal/SSH without a browser or background service. Discover commands with `capabilities --format json`; use scoped `--help`, `schema`, or [generated command reference](references/commands.md) when needed. `-H` is the complete offline manual including config/env mappings and naming templates.

For Agent calls explicitly pass `--format json --non-interactive`, or jsonl for streaming. JSON is one envelope; JSONL emits item/error and a terminal summary. Progress and QR characters go to stderr. Download progress is automatic on a stderr TTY; `--progress` forces sparse plain status lines in pipes, `--no-progress` disables it, and `--quiet` overrides forced progress. Parse only stdout as JSON/JSONL; do not merge stderr into it. Progress reports transferred bytes, speed and ETA when total size is known; “verifying” is not yet a completed download. A missing summary means the stream ended abnormally. Respect actual exit codes and `error.code`; `ok=true` alone on auth start does not mean login finished.

## Authentication

Check `auth status --check` or `me get` using the intended profile. Local `auth status` is cached (`verified=false`). If needed let the user run `auth login --method sms` or `auth login --method qr` in their own terminal. QR uses the phone Xiaohongshu app; light terminals use `--qr-theme light`.

For split SMS: `auth start --method sms --phone <phone> --format json --non-interactive`, then `auth verify --challenge <id> --code-stdin --format json --non-interactive`. Supply the code as stdin data followed by EOF, not shell interpolation or a config/log entry. QR start returns `qr_text`; `auth challenge <id>` queries once, `auth wait <id> --timeout 120` polls in the current process.

There is one pending challenge per profile, for at most five minutes. Continue it or explicitly cancel; an unknown SMS send outcome is not a reason to resend. After final credential exchange but a failed identity check, `auth challenge <id>` retries identity without re-exchanging the code. Platform verification errors require an explicit user handoff, not a browser fallback or repeated requests.

## Query and preserve access context

- `me notes/likes/favorites` queries the actual logged-in account; `user notes/likes/favorites <user-url-or-id>` queries a target under the current viewer's permissions. Likes/favorites are actions by that user, not received notifications. The list owner and each note's author are separate identities.
- Lists return NoteSummary and `ref`. Keep each note's own xsec_token/xsec_source for `note get` and downloads; do not substitute a profile token. Full/short share links and a single-link share text can be used directly.
- `search notes <keyword>` supports type all/image/video and sort relevance/latest/likes. Obtain full details before deciding a cover is a complete image set; `note get` returns ordered image/video/Live Photo media variants and backups.
- Default limit is 20. `--all` is still bounded by max-pages and timeout. Inspect page.exhausted/stop_reason. Continue with the returned cursor and the same viewer/target/filter/page-size. Local cursor state expires after 24 hours and is not portable to a different machine/state directory. Buffered page items are consumed before fetching the next page.
- Private/forbidden (exit 11) differs from a real successful empty list. `user access` reports observations; `--check` explicitly probes the three lists. Do not switch accounts/anonymous mode to work around a refusal.

## Download explicit sources

Use exactly one source: positional note links, `--input <file|-> --input-format urls|jsonl`, or `--user <me|user> --source posts|likes|favorites`. JSONL input contains NoteRef per line, not CLI event envelopes; extract `item.data.ref` first. For provenance across a user list, prefer direct user-source download.

When paths or quality need review, use `--dry-run` to inspect planned paths/candidates. It may perform HTTP and update login/pagination state but creates no media output/archive. `--paths` controls root; `-o` controls a relative filename template. Example:

```sh
xhs-dl download '<note-url>' --paths './downloads' \
  -o '{author.id}/{note.id}/{index:03}_{media.role}.{ext}' \
  --write-info-json --write-description --format jsonl --non-interactive
```

Timestamp example: `{downloaded_at:%Y%m%d%H%M%S}` with `--timezone Asia/Shanghai`; fallback example `{title|untitled}`. Include index and role to separate Live Photo pairs. Templates never execute code; titles/descriptions are untrusted data and must not become shell instructions.

Images and videos default to quality best. Video details merge up to three API observations because successful responses can omit codec buckets; inspect `resolution` for source, candidate counts and warnings. Best means the highest candidate observed within this bounded sampling, not a guarantee of the platform's hidden original. Original requires an explicit original candidate; numeric quality requires exact height unless fallback was explicitly allowed. `--video-codec auto` keeps quality first; select h264/hevc/av1/vvc only when the user wants an encoding constraint. It filters available candidates and does not transcode. `media_info.source=file_header` distinguishes local header facts from API metadata; header inspection is not a full decode check. `--media live` selects matching image/video pairs. Rate limit is aggregate bytes/second; request interval is API milliseconds.

The archive verifies size and SHA-256 before skipping. Re-running best upgrades a verified, managed file if a higher candidate appears, and skips equal/lower quality. Modified or unrecognized files still follow the collision policy. Existing unverified paths default to error; choose skip/overwrite/rename only according to the user's requested handling. Range resume uses validators; partial media stay on disk on interruption. Verify summary and returned paths. List/download checkpoints are separate, so listed does not imply downloaded. Unliking/unfavoriting never deletes local files.

## Recover and report evidence

Exit 2 input/config, 3 authentication, 4 user action/verification, 5 rate limit, 6 network/busy, 7 unavailable content, 8 filesystem, 9 partial failure, 10 protocol incompatibility, 11 permission denied, 130 interrupted. Single-note single-media failures preserve the underlying error (e.g. QUALITY_UNAVAILABLE/7); batch or partial failures use PARTIAL_FAILURE/9. Preserve completed outputs and inspect partial_result/terminal_error. Avoid unbounded retries.

`config path` locates private state; `config show` reports redacted final values and sources. Use the same profile/state directory across calls. Do not print/copy credential files to chat. qr_text, access tokens and signed CDN query strings are short-lived sensitive data; info.json omits these by default.

`capabilities.verification` describes observed local evidence, not guaranteed platform stability. First-party SMS/account, content queries, pagination and image/video/Live Photo downloads have been verified in the documented local environment. QR final confirmation, remote CI platforms and favorite-folder grouping have separate verification limits; do not infer their success from another capability.

#!/usr/bin/env node
import { DownloadProgressDisplay } from "./infrastructure/progress.js";
import { DownloadEngine } from "./download/engine.js";
import { inputRefs } from "./download/input.js";
import { validateTemplate } from "./download/template.js";
import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { input, password } from "@inquirer/prompts";
import { terminalQr } from "./infrastructure/qr.js";
import { z } from "zod";
import {
  bindings,
  loadConfig,
  configSchema,
  redactConfig,
  type Config,
} from "./config/config.js";
import { ContentService } from "./content/service.js";
import {
  downloadItemSchema,
  downloadResultSchema,
  errorSchema,
  noteSchema,
  summarySchema,
  refSchema,
  mediaSchema,
  accessSchema,
  profileSchema,
  listResultSchema,
  type ListOptions,
  type ListResult,
  type Summary,
} from "./domain/content.js";
import { userSchema } from "./domain/models.js";
import { AppError, exitCodes } from "./domain/errors.js";
import { AuthService } from "./auth/service.js";
import { publicChallengeSchema } from "./auth/public-schema.js";

const version = "0.2.0";
const requestId = randomUUID();
let config: Config | undefined;
let commandName = "cli";
let output: "human" | "json" | "jsonl" = process.stdout.isTTY
  ? "human"
  : "jsonl";
let activeSignal: AbortSignal | undefined;
let streamedCount = 0;
let activeDownloadResult: unknown;
const interrupted = new AbortController();
process.once("SIGINT", () =>
  interrupted.abort(new DOMException("Interrupted", "AbortError")),
);
process.once("SIGTERM", () =>
  interrupted.abort(new DOMException("Terminated", "AbortError")),
);
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
function integer(value: string) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new InvalidArgumentError("必须为正整数。");
  return n;
}
function nonnegative(value: string) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0)
    throw new InvalidArgumentError("必须为非负数。");
  return n;
}
function numeric(value: string) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0)
    throw new InvalidArgumentError("必须为正数（单位：秒）。");
  return n;
}
function machinePreference() {
  const args = process.argv.slice(2);
  let value = process.env.XHS_DL_FORMAT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format") value = args[i + 1];
    if (args[i]?.startsWith("--format=")) value = args[i]!.slice(9);
  }
  if (["human", "json", "jsonl"].includes(value ?? ""))
    output = value as typeof output;
}
machinePreference();
const program = new Command()
  .name("xhs-dl")
  .description(
    "纯 HTTP 小红书 CLI：登录、用户列表、搜索、帖子详情与可恢复下载。",
  )
  .version(version)
  .exitOverride()
  .option("--config <path>", "读取指定 TOML 配置文件")
  .option("--no-config", "不读取配置文件（环境变量和 flags 仍有效）")
  .option("--profile <name>", "独立账号状态名称，默认 default")
  .option(
    "--format <format>",
    "human | json | jsonl；TTY 默认 human，管道默认 jsonl",
  )
  .option("--fields <paths>", "仅保留 data 中指定的逗号分隔字段（支持点路径）")
  .option("--non-interactive", "禁止交互输入；使用 auth start/verify/wait")
  .option("--timeout <seconds>", "整体超时秒数，默认 300", numeric)
  .option(
    "--request-timeout <seconds>",
    "每个 HTTP 请求超时秒数，默认 30",
    numeric,
  )
  .option("--proxy <url>", "HTTP(S) CONNECT 代理地址")
  .option("--retries <count>", "下载/只读请求额外重试次数，默认 2", nonnegative)
  .option(
    "--request-interval <ms>",
    "内容 API 请求最小间隔毫秒，默认 1000",
    nonnegative,
  )
  .option("--quiet", "不输出等待和下载进度")
  .option("--verbose", "显示脱敏诊断字段")
  .addOption(
    new Option(
      "--no-color",
      "关闭颜色（二维码始终使用无 ANSI 字符矩阵）",
    ).default(undefined),
  )
  .option("-H, --help-all", "输出所有已实现命令、参数、登录流程与错误约定");
program.configureOutput({ writeErr: () => {}, outputError: () => {} });
const helpTail = `
Agent 调用：xhs-dl capabilities --format json
           xhs-dl auth start --method sms --phone <phone> --format json --non-interactive
           xhs-dl auth verify --challenge <id> --code-stdin --format json --non-interactive
           xhs-dl me get --format json --non-interactive
stdout 仅写结果；日志/二维码写 stderr。凭证位于 config path 报告的应用状态目录。
退出码：0 成功，2 输入/配置错误，3 未登录，4 需验证码/扫码/验证，5 限流，6 网络/忙，
        7 内容不可访问，8 本地文件错误，9 部分失败，10 协议不兼容，11 权限拒绝，130 中断。
-H 查看完整手册；schema 查看机器结构；skills/xhs-dl/SKILL.md 为 Agent 使用说明。
已支持帖子详情、搜索和用户三类列表；权限拒绝退出11，部分失败退出9。
`;
program.addHelpText("after", helpTail);
function commands(
  command = program,
  prefix = "",
): Array<Record<string, unknown>> {
  const name = prefix || program.name();
  return [
    {
      name,
      description: command.description(),
      usage: command.usage(),
      requires_login: name.startsWith("xhs-dl me")
        ? true
        : name.startsWith("xhs-dl user")
          ? "platform_dependent"
          : false,
      arguments: command.registeredArguments.map((argument) => ({
        name: argument.name(),
        required: argument.required,
        variadic: argument.variadic,
        description: argument.description,
      })),
      options: command.options.map((o) => ({
        flags: o.flags,
        description: o.description,
        default: o.defaultValue ?? null,
      })),
    },
    ...command.commands.flatMap((c) => commands(c, `${name} ${c.name()}`)),
  ];
}
function fullHelp() {
  for (const entry of commands())
    process.stdout.write(
      `${entry.name} ${entry.usage}\n${entry.description}\n${(entry.options as Array<{ flags: string; description: string }>).map((o) => `  ${o.flags}  ${o.description}`).join("\n")}\n\n`,
    );
  process.stdout.write(
    helpTail +
      "\n短信：auth login --method sms [--phone <phone>]，按提示输入。\n扫码：auth login --method qr，在手机小红书扫描终端二维码。\nAgent：auth start 创建临时挑战，verify 从 stdin 读验证码；QR 用 challenge 单次查询或 wait 轮询。\nstart 发起成功不等于已经登录；auth status --check 和 me get 才进行真实身份检查。\n短信不自动重发。发送超时结果未知时先检查手机，避免重复 start。\n--config <file> 使用 TOML；config init 生成当前版本支持的示例。验证码与 Cookie 不写配置。\nJSON 输出单个 envelope；JSONL 输出 item/error 加 summary。缺失 summary 表示异常中断。\n不运行浏览器，不自动安装全局 Skill，不将敏感凭证写入仓库。\n",
  );
  process.stdout.write(
    extraManual +
      Object.entries(bindings)
        .map(
          ([key, value]) =>
            "  XHS_DL_" + key + " → " + value.path + " (" + value.type + ")",
        )
        .join("\n") +
      "\n\n默认配置：\n" +
      JSON.stringify(configSchema.parse({}), null, 2) +
      "\n",
  );
}
const extraManual = `
用户列表：me notes/likes/favorites；user notes/likes/favorites <主页或ID>。
--all 遍历当前身份可见结果，仍受 --max-pages（默认100）和 --timeout 约束。
列表摘要不等于完整详情；每条 ref 带自己的 xsec_token，不能用主页 token 代替帖子 token。
--cursor 依赖相同机器状态目录、实际账号、目标和筛选；24小时过期；页中剩余条目会保留。
权限拒绝退出11；空列表仅在平台明确成功/结束时才表示确实为空；中途失败退出9并保留结果。

下载：download <链接...>；或 --input <file|-> --input-format urls|jsonl；或 --user <me|主页|ID> --source posts|likes|favorites。
三种来源互斥。JSONL输入每行必须是NoteRef（可从查询事件item.data.ref提取），不接收事件envelope。
--dry-run 返回计划路径、媒体候选和质量，不写下载目录与归档；允许网络解析和状态更新。
默认模板：{author.id}/{note.id}/{index:03}_{media.role}.{ext}
模板字段：note.id/title/type、title、author.id/name、published_at、downloaded_at、index、media.id/role、ext、source.owner_id/kind。
缺失字段可用 {title|untitled}；未知字段报错。时间格式：%Y年 %m月 %d日 %H时 %M分 %S秒，默认UTC。
示例：-o '{downloaded_at:%Y%m%d%H%M%S}_{note.id}/{index:03}_{media.role}.{ext}' --timezone Asia/Shanghai。
模板必须是根目录内相对路径；变量路径分隔符被清理，拒绝 ..、绝对模板和输出目录内的符号链接。
quality=best 选择当前可用最高档，original 仅接受明确原片候选，数字要求精确高度；缺档时仅显式 allow-quality-fallback 才降级。
已完成归档按实际文件大小/SHA-256核对后跳过，best按请求策略保持幂等，不自动升级既有文件。
--on-exists error（默认）|skip|overwrite|rename 控制未被归档核验的已有文件。
.part + 验证器用于续传，URL/ETag不一致或服务端忽略Range时重下；备用CDN和过期地址刷新均有限。
--rate-limit 是所有媒体共享的字节/秒，0不限；--request-interval 是API请求间隔毫秒。
元数据/正文为显式选项；info.json移除访问token和CDN查询签名。取消收藏不会删除本地文件。

配置：默认→用户文件→当前目录唯一项目文件→--config→XHS_DL_*→flags。
配置相对路径基于该配置文件所在目录；CLI相对路径基于当前目录；config show显示最终值及sources。
--no-config 仅跳过文件。布尔环境值只接受 true/false/1/0。query.limit 在显式 --all 时忽略。
环境变量映射：
`;
function project(value: unknown, fields?: string) {
  if (!fields) return value;
  const result: Record<string, unknown> = {};
  for (const key of fields
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)) {
    if (
      key
        .split(".")
        .some((p) => ["__proto__", "constructor", "prototype"].includes(p))
    )
      throw new AppError("INVALID_FIELDS", "字段路径无效。", 2);
    let current: unknown = value;
    for (const part of key.split("."))
      current =
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[part]
          : undefined;
    if (current !== undefined) result[key] = current;
  }
  return result;
}
function isList(value: unknown): value is ListResult {
  return (
    !!value &&
    typeof value === "object" &&
    "items" in value &&
    "page" in value &&
    "counts" in value
  );
}
function streamItem(data: unknown, cmd: Command) {
  streamedCount++;
  process.stdout.write(
    JSON.stringify({
      schema_version: "1.0",
      request_id: requestId,
      command: commandName,
      type: "item",
      data: project(data, cmd.optsWithGlobals().fields),
    }) + "\n",
  );
}
function emit(data: unknown, cmd: Command) {
  const projected = project(data, cmd.optsWithGlobals().fields);
  if (output === "human") {
    process.stdout.write(JSON.stringify(projected, null, 2) + "\n");
    return;
  }
  const base = {
    schema_version: "1.0",
    request_id: requestId,
    command: commandName,
  };
  if (output === "json")
    process.stdout.write(
      JSON.stringify({
        ...base,
        ok: true,
        data: projected,
        error: null,
        meta: { transport: "http" },
      }) + "\n",
    );
  else if (isList(data)) {
    const { items, ...summary } = data;
    void items;
    process.stdout.write(
      JSON.stringify({
        ...base,
        type: "summary",
        ok: true,
        count: data.counts.emitted,
        ...summary,
        error: null,
      }) + "\n",
    );
  } else if (
    data &&
    typeof data === "object" &&
    "summary" in data &&
    "items" in data
  ) {
    const { items, summary, ...rest } = data as Record<string, unknown>;
    void items;
    process.stdout.write(
      JSON.stringify({
        ...base,
        type: "summary",
        ok: true,
        ...rest,
        summary,
        error: null,
      }) + "\n",
    );
  } else {
    process.stdout.write(
      JSON.stringify({ ...base, type: "item", data: projected }) + "\n",
    );
    process.stdout.write(
      JSON.stringify({
        ...base,
        type: "summary",
        ok: true,
        count: 1,
        error: null,
      }) + "\n",
    );
  }
}
async function context(cmd: Command) {
  const opts = cmd.optsWithGlobals();
  config = await loadConfig({
    config: typeof opts.config === "string" ? opts.config : undefined,
    configEnabled: opts.config !== false,
    profile: opts.profile,
    format: opts.format,
    proxy: opts.proxy,
    timeout: opts.timeout,
    requestTimeout: opts.requestTimeout,
    retries: opts.retries,
    requestInterval: opts.requestInterval,
    overrides: Object.fromEntries(
      Object.entries({
        "output.color": opts.color,
        "query.limit": opts.limit,
        "query.page_size": opts.pageSize,
        "query.max_pages": opts.maxPages,
        "query.type": opts.type,
        "query.sort": opts.sort,
        "download.paths": opts.paths,
        "download.template": opts.output,
        "download.timezone": opts.timezone,
        "download.quality": opts.quality,
        "download.progress":
          opts.progress === undefined
            ? undefined
            : opts.progress
              ? "always"
              : "never",
        "download.video_codec": opts.videoCodec,
        "download.allow_quality_fallback": opts.allowQualityFallback,
        "download.media": opts.media,
        "download.concurrency": opts.concurrency,
        "download.rate_limit": opts.rateLimit,
        "download.resume": opts.resume,
        "download.on_exists": opts.onExists,
        "download.archive": opts.archive,
        "download.write_info_json": opts.writeInfoJson,
        "download.write_description": opts.writeDescription,
        "download.dry_run": opts.dryRun,
      }).filter(([, v]) => v !== undefined),
    ),
  });
  output = config.output.format ?? (process.stdout.isTTY ? "human" : "jsonl");
  activeSignal = AbortSignal.any([
    interrupted.signal,
    AbortSignal.timeout(config.network.timeout_seconds * 1000),
  ]);
  if (opts.verbose)
    process.stderr.write(
      JSON.stringify({
        diagnostic: "http_cli",
        command: commandName,
        profile: config.profile,
        request_timeout_seconds: config.network.request_timeout_seconds,
        retries: config.network.retries,
      }) + "\n",
    );
  return {
    service: new AuthService(config, activeSignal),
    content: new ContentService(config, activeSignal),
    opts,
  };
}
function action(
  command: Command,
  name: string,
  fn: (cmd: Command, ...args: any[]) => Promise<unknown>,
) {
  command.action(async (...args: any[]) => {
    commandName = name;
    const cmd = args.at(-1) as Command;
    const data = await fn(cmd, ...args.slice(0, -1));
    emit(data, cmd);
  });
  return command;
}
function checkInteractive(cmd: Command) {
  const opts = cmd.optsWithGlobals();
  if (
    !process.stdin.isTTY ||
    !process.stderr.isTTY ||
    opts.nonInteractive ||
    output !== "human"
  )
    throw new AppError(
      "INTERACTION_REQUIRED",
      "auth login 需要交互终端和 human 输出；Agent 请使用 auth start/verify/wait。",
      2,
    );
}
async function qr(text: string, path?: string, theme = "dark") {
  const rendered = terminalQr(text, theme);
  if (path)
    await writeFile(resolve(path), rendered.text, { mode: 0o600, flag: "wx" });
  if (output === "human") {
    if (process.stderr.columns && rendered.columns > process.stderr.columns)
      process.stderr.write(
        `二维码需 ${rendered.columns} 列，请加宽终端，避免折行。\n`,
      );
    process.stderr.write(rendered.text);
  }
}
async function wait(
  service: AuthService,
  id: string,
  opts: Record<string, unknown>,
) {
  while (true) {
    if (activeSignal?.aborted)
      throw new AppError(
        "WAIT_INCOMPLETE",
        "等待已结束；若挑战仍有效可继续 auth wait。",
        interrupted.signal.aborted ? 130 : 4,
        { challenge_id: id },
        false,
        "continue_login",
      );
    const result = await service.challenge(id);
    if (result.status === "authenticated") return result;
    if (result.method !== "qr")
      throw new AppError(
        "INVALID_CHALLENGE_STATE",
        "wait 只适用于二维码；短信请用 auth verify。",
        2,
      );
    if (["failed", "cancelled"].includes(result.status))
      throw new AppError(
        "CHALLENGE_EXPIRED",
        "登录挑战已终止，请重新发起。",
        4,
      );
    if (result.status === "expired")
      throw new AppError("CHALLENGE_EXPIRED", "二维码已过期，请重新发起。", 4);
    if (!opts.quiet) process.stderr.write(`登录状态：${result.status}\n`);
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        activeSignal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => done();
      const timer = setTimeout(done, 2000);
      activeSignal?.addEventListener("abort", abort, { once: true });
    });
  }
}
async function readCode() {
  const abort = () =>
    process.stdin.destroy(
      new AppError(
        "TIMEOUT",
        "验证码输入等待已超时或中断。",
        interrupted.signal.aborted ? 130 : 6,
      ),
    );
  activeSignal?.addEventListener("abort", abort, { once: true });
  try {
    let code = "";
    for await (const chunk of process.stdin) {
      code += String(chunk);
      if (code.length > 128)
        throw new AppError("INVALID_CODE", "验证码输入过长。", 2);
    }
    return code.trim();
  } finally {
    activeSignal?.removeEventListener("abort", abort);
  }
}
const auth = program.command("auth").description("纯 HTTP 登录与本地会话管理");
for (const group of [auth])
  group.action(() => {
    throw new AppError(
      "INVALID_ARGUMENT",
      "请指定子命令；使用 --help 查看。",
      2,
    );
  });
action(
  auth
    .command("login")
    .description("终端交互登录：短信或二维码")
    .option("--method <method>", "sms | qr", "sms")
    .option("--phone <phone>", "手机号（不含国家代码）")
    .option("--zone <zone>", "国家/地区代码", "86")
    .option("--qr-output <path>", "保存字符二维码到新文件")
    .option("--qr-theme <theme>", "终端背景 dark | light", "dark"),
  "auth.login",
  async (cmd) => {
    const { service, opts } = await context(cmd);
    checkInteractive(cmd);
    terminalQr("validation", opts.qrTheme);
    if (!["sms", "qr"].includes(opts.method))
      throw new AppError("INVALID_ARGUMENT", "method 只能为 sms 或 qr。", 2);
    if (opts.qrOutput && opts.method !== "qr")
      throw new AppError("INVALID_ARGUMENT", "qr-output 仅用于二维码登录。", 2);
    const phone =
      opts.method === "sms"
        ? (opts.phone ??
          (await input({ message: "手机号：" }, { signal: activeSignal })))
        : undefined;
    const started = await service.start(opts.method, phone, opts.zone);
    if (opts.method === "qr") {
      await qr(started.qr_text!, opts.qrOutput, opts.qrTheme);
      process.stderr.write("请用小红书扫描二维码并确认登录。\n");
      return wait(service, started.challenge_id, opts);
    }
    process.stderr.write(`短信已发送至 ${started.phone_masked}。\n`);
    const code = await password(
      { message: "验证码：", mask: "*" },
      { signal: activeSignal },
    );
    return service.verify(started.challenge_id, code.trim());
  },
);
action(
  auth
    .command("start")
    .description("发起可跨进程继续的登录挑战")
    .requiredOption("--method <method>", "sms | qr")
    .option("--phone <phone>", "短信手机号")
    .option("--zone <zone>", "国家/地区代码", "86")
    .option("--qr-output <path>", "另存字符二维码文件")
    .option("--qr-theme <theme>", "终端背景 dark | light", "dark"),
  "auth.start",
  async (cmd) => {
    const { service, opts } = await context(cmd);
    if (!["sms", "qr"].includes(opts.method))
      throw new AppError("INVALID_ARGUMENT", "method 只能为 sms 或 qr。", 2);
    terminalQr("validation", opts.qrTheme);
    if (opts.qrOutput && opts.method !== "qr")
      throw new AppError("INVALID_ARGUMENT", "qr-output 仅用于二维码登录。", 2);
    const result = await service.start(opts.method, opts.phone, opts.zone);
    if (result.qr_text) await qr(result.qr_text, opts.qrOutput, opts.qrTheme);
    return result;
  },
);
action(
  auth
    .command("verify")
    .description("从 stdin 读取验证码并完成短信登录")
    .requiredOption("--challenge <id>", "start 返回的 challenge_id")
    .requiredOption("--code-stdin", "从标准输入读取验证码，需以 EOF 结束"),
  "auth.verify",
  async (cmd) => {
    const { service, opts } = await context(cmd);
    return service.verify(opts.challenge, await readCode());
  },
);
action(
  auth
    .command("challenge <id>")
    .description("读取短信挑战阶段或 HTTP 查询一次扫码进度"),
  "auth.challenge",
  async (cmd, id) => {
    const { service } = await context(cmd);
    return service.challenge(id);
  },
);
action(
  auth
    .command("wait <id>")
    .description("当前进程轮询二维码直到成功或整体 timeout"),
  "auth.wait",
  async (cmd, id) => {
    const { service, opts } = await context(cmd);
    return wait(service, id, opts);
  },
);
action(
  auth.command("cancel <id>").description("取消本地未完成登录挑战"),
  "auth.cancel",
  async (cmd, id) => {
    const { service } = await context(cmd);
    return service.cancel(id);
  },
);
action(
  auth
    .command("status")
    .description("查看本地状态；check 检查真实 HTTP 登录状态")
    .option("--check", "访问平台确认身份"),
  "auth.status",
  async (cmd) => {
    const { service, opts } = await context(cmd);
    return service.status(!!opts.check);
  },
);
action(
  auth.command("logout").description("清除当前 profile 的本地会话和挑战"),
  "auth.logout",
  async (cmd) => {
    const { service } = await context(cmd);
    return service.logout();
  },
);
action(
  auth
    .command("import")
    .description("显式导入 Cookie 文件，HTTP 验证后保存")
    .requiredOption(
      "--cookie-file <path>",
      "Cookie header、JSON 数组或 Netscape 文件",
    ),
  "auth.import",
  async (cmd) => {
    const { service, opts } = await context(cmd);
    return service.importCookie(
      await readFile(resolve(opts.cookieFile), "utf8"),
    );
  },
);
const me = program
  .command("me")
  .description("当前实际登录账号")
  .action(() => {
    throw new AppError("INVALID_ARGUMENT", "请指定 me get。", 2);
  });
action(
  me.command("get").description("通过 HTTP 查询并更新当前登录者资料"),
  "me.get",
  async (cmd) => {
    const { content } = await context(cmd);
    return content.current();
  },
);
function listFlags(cmd: Command, search = false) {
  cmd
    .option("--limit <n>", "最多返回的唯一帖子数，默认20", integer)
    .option("--all", "遍历全部可见结果（仍受 timeout/max-pages 限制）")
    .option("--page-size <n>", "每页请求数量，1至30", integer)
    .option("--max-pages <n>", "本次最多请求页数，默认100", integer)
    .option("--cursor <cursor>", "继续本机同一账号和查询的分页状态")
    .option("--refresh", "开始新的网络查询；与cursor互斥")
    .option("--type <type>", "all | image | video");
  if (search) cmd.option("--sort <sort>", "relevance | latest | likes");
  return cmd;
}
function refFlags(cmd: Command) {
  return cmd
    .option("--xsec-token <token>", "补充链接访问 token")
    .option("--xsec-source <source>", "补充链接访问来源");
}
function listOptions(opts: Record<string, any>): ListOptions {
  return {
    limit: opts.all ? opts.limit : config!.query.limit,
    all: opts.all,
    pageSize: config!.query.page_size,
    maxPages: config!.query.max_pages,
    cursor: opts.cursor,
    refresh: opts.refresh,
    type: config!.query.type,
    sort: config!.query.sort,
  };
}
function listSink(cmd: Command) {
  return output === "jsonl"
    ? (item: Summary) => {
        streamItem(item, cmd);
        return Promise.resolve();
      }
    : undefined;
}
const user = program
  .command("user")
  .description("指定用户资料、发布、喜欢、收藏与权限")
  .action(() => {
    throw new AppError("INVALID_ARGUMENT", "请指定 user 子命令。", 2);
  });
action(
  refFlags(user.command("get <user>").description("查看指定用户资料")),
  "user.get",
  async (cmd, input) => {
    const { content, opts } = await context(cmd);
    const ref = await content.resolve(
      input,
      "user",
      opts.xsecToken,
      opts.xsecSource,
    );
    return content.profile(ref);
  },
);
for (const [name, kind] of [
  ["notes", "posts"],
  ["likes", "likes"],
  ["favorites", "favorites"],
] as const) {
  action(
    listFlags(
      me
        .command(name)
        .description(
          "读取本人" +
            { posts: "发布", likes: "喜欢", favorites: "收藏" }[kind] +
            "帖子",
        ),
    ),
    "me." + name,
    async (cmd) => {
      const { content, opts } = await context(cmd);
      return content.list(
        "me",
        kind,
        listOptions(opts),
        listSink(cmd),
        output !== "jsonl",
      );
    },
  );
  action(
    refFlags(
      listFlags(
        user
          .command(name + " <user>")
          .description("读取当前身份可见的用户" + kind + "帖子"),
      ),
    ),
    "user." + name,
    async (cmd, input) => {
      const { content, opts } = await context(cmd);
      const ref = await content.resolve(
        input,
        "user",
        opts.xsecToken,
        opts.xsecSource,
      );
      return content.list(
        ref,
        kind,
        listOptions(opts),
        listSink(cmd),
        output !== "jsonl",
      );
    },
  );
}
action(
  refFlags(
    user
      .command("access <user>")
      .description("列表权限观察；check显式发起有限HTTP探测")
      .option("--check", "探测三类列表各一页"),
  ),
  "user.access",
  async (cmd, input) => {
    const { content, opts } = await context(cmd);
    const ref = await content.resolve(
      input,
      "user",
      opts.xsecToken,
      opts.xsecSource,
    );
    return content.inspectAccess(ref, !!opts.check);
  },
);
const note = program
  .command("note")
  .description("帖子完整详情与图片/视频地址")
  .action(() => {
    throw new AppError("INVALID_ARGUMENT", "请指定 note get。", 2);
  });
action(
  refFlags(
    note
      .command("get <note>")
      .description("解析完整链接、分享文本、短链或ID，返回完整媒体候选"),
  ),
  "note.get",
  async (cmd, input) => {
    const { content, opts } = await context(cmd);
    return content.note(input, opts.xsecToken, opts.xsecSource);
  },
);
const search = program
  .command("search")
  .description("搜索帖子")
  .action(() => {
    throw new AppError("INVALID_ARGUMENT", "请指定 search notes。", 2);
  });
action(
  listFlags(
    search.command("notes <keyword>").description("关键词搜索与可恢复分页"),
    true,
  ),
  "search.notes",
  async (cmd, keyword) => {
    const { content, opts } = await context(cmd);
    return content.search(
      keyword,
      listOptions(opts),
      listSink(cmd),
      output !== "jsonl",
    );
  },
);
const download = refFlags(
  listFlags(
    program
      .command("download [urls...]")
      .description("下载帖子、批量输入或用户来源列表"),
  ),
)
  .option("--input <file-or-dash>", "批量输入文件；-表示stdin")
  .option("--input-format <format>", "urls | jsonl", "urls")
  .option("--user <user>", "用户主页、ID，或me")
  .option("--source <source>", "posts | likes | favorites，必须配合user")
  .option("--paths <path>", "下载根目录")
  .option("-o, --output <template>", "文件相对路径模板")
  .option("--timezone <zone>", "模板日期IANA时区，默认UTC")
  .option("--quality <quality>", "best（默认最优）| original | 精确视频高度")
  .option(
    "--video-codec <codec>",
    "auto（默认不限编码）| h264 | hevc | av1 | vvc；只选择，不转码",
  )
  .option("--allow-quality-fallback", "没有指定清晰度时允许降级")
  .addOption(
    new Option("--no-allow-quality-fallback", "禁止质量降级").default(
      undefined,
    ),
  )
  .option("--media <media>", "all | images | videos | live")
  .option("--progress", "强制在 stderr 显示进度；非终端输出节流纯文本")
  .addOption(new Option("--no-progress", "关闭下载进度显示").default(undefined))
  .option("--concurrency <n>", "媒体并发，默认3，最大32", integer)
  .option(
    "--rate-limit <bytes-per-second>",
    "聚合下载限速，0为不限",
    nonnegative,
  )
  .option("--resume", "启用经身份核对的Range续传")
  .addOption(new Option("--no-resume", "从头下载").default(undefined))
  .option("--archive <path>", "JSONL下载归档路径")
  .option("--on-exists <policy>", "skip | overwrite | error | rename")
  .option("--write-info-json", "输出脱敏帖子元数据")
  .addOption(
    new Option("--no-write-info-json", "不输出帖子元数据").default(undefined),
  )
  .option("--write-description", "输出帖子正文")
  .addOption(
    new Option("--no-write-description", "不输出帖子正文").default(undefined),
  )
  .option("--dry-run", "仅解析与规划，不下载，不创建输出目录/归档")
  .addOption(
    new Option("--no-dry-run", "执行真实下载，覆盖配置中的dry_run").default(
      undefined,
    ),
  );
action(download, "download", async (cmd, urls: string[]) => {
  const { content, opts } = await context(cmd);
  const sources =
    Number(!!urls.length) + Number(!!opts.input) + Number(!!opts.user);
  if (sources !== 1 || !!opts.source !== !!opts.user)
    throw new AppError(
      "INVALID_ARGUMENT",
      "位置链接、input、user/source 必须选择且仅选择一组。",
      2,
    );
  if (opts.source && !["posts", "likes", "favorites"].includes(opts.source))
    throw new AppError(
      "INVALID_ARGUMENT",
      "source 必须为 posts/likes/favorites。",
      2,
    );
  if (
    !opts.user &&
    (opts.all || opts.cursor || opts.limit !== undefined || opts.refresh)
  )
    throw new AppError(
      "INVALID_ARGUMENT",
      "列表分页参数仅用于 user/source 来源下载。",
      2,
    );
  validateTemplate(config!.download.template);
  const progress = new DownloadProgressDisplay(
    process.stderr,
    config!.download.progress,
    !!opts.quiet,
  );
  try {
    const engine = new DownloadEngine(
      content,
      async (item) => {
        progress.complete(item.path, item.status);
        if (output === "jsonl") streamItem(item, cmd);
        else if (
          output === "human" &&
          !opts.quiet &&
          (!progress.enabled || item.status !== "downloaded")
        )
          progress.log(
            item.status + ": " + (item.path ?? item.note_id ?? "input"),
          );
      },
      output !== "jsonl",
      undefined,
      (event) => progress.update(event),
    );
    activeDownloadResult = engine.result;
    if (opts.user) {
      const target =
        opts.user === "me"
          ? "me"
          : await content.resolve(
              opts.user,
              "user",
              opts.xsecToken,
              opts.xsecSource,
            );
      const result = await content.list(
        target,
        opts.source,
        listOptions(opts),
        (item) => engine.listItem(item),
        false,
      );
      engine.result.page = result.page;
    } else {
      const values = opts.input
        ? await inputRefs(opts.input, opts.inputFormat, activeSignal)
        : urls;
      for (const [index, value] of values.entries()) {
        try {
          const ref = await content.resolve(
            value,
            "note",
            opts.xsecToken,
            opts.xsecSource,
          );
          await engine.note(ref);
        } catch (error) {
          if (activeSignal?.aborted) throw error;
          await engine.invalidInput(error, index + 1);
        }
      }
    }
    return engine.finish();
  } finally {
    progress.close();
  }
});
const configCommand = program
  .command("config")
  .description("配置与状态路径（不输出凭证）")
  .action(() => {
    throw new AppError("INVALID_ARGUMENT", "请指定 config 子命令。", 2);
  });
action(
  configCommand.command("show").description("显示脱敏后的有效配置"),
  "config.show",
  async (cmd) => {
    await context(cmd);
    return redactConfig(config!);
  },
);
action(
  configCommand.command("path").description("显示配置与账号状态目录"),
  "config.path",
  async (cmd) => {
    const { service } = await context(cmd);
    return {
      config_dir: config!.configDir,
      state_dir: config!.stateDir,
      profile_dir: service.store.dir,
      config_files: config!.configFiles,
    };
  },
);
action(
  configCommand.command("validate").description("校验已选配置文件"),
  "config.validate",
  async (cmd) => {
    await context(cmd);
    return { valid: true, files: config!.configFiles };
  },
);
action(
  configCommand
    .command("init")
    .description("创建当前版本支持的示例配置")
    .option("--path <path>", "写入路径，默认用户配置目录"),
  "config.init",
  async (cmd) => {
    const { opts } = await context(cmd);
    const path = opts.path
      ? resolve(opts.path)
      : resolve(config!.configDir, "xhs-dl.conf");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      'schema_version = 1\nprofile = "default"\n\n[output]\nformat = "human"\ncolor = false\n\n[network]\nrequest_timeout_seconds = 30\ntimeout_seconds = 300\n',
      { mode: 0o600, flag: "wx" },
    );
    return { path };
  },
);
function capabilities() {
  return {
    version,
    protocol_version: "pc-http-2026-11",
    transport: "http",
    verification: {
      date: "2026-11-17",
      platform: "macOS arm64",
      node: "22.22.2",
      scope: "local environment, not a platform stability guarantee",
    },
    browser_required: false,
    commands: commands(),
    schema_version: "1.0",
    exit_codes: exitCodes,
    capabilities: {
      sms_login: { implemented: true, live_verified: true },
      qr_login: {
        implemented: true,
        live_verified: false,
        verified_steps: [
          "anonymous_activation",
          "qr_creation",
          "cross_process_polling",
        ],
      },
      current_user: { implemented: true, live_verified: true },
      note_detail: {
        implemented: true,
        live_verified: true,
        verified_types: ["image", "video", "live_photo"],
      },
      search: { implemented: true, live_verified: true },
      user_lists: { implemented: true, live_verified: true },
      download: { implemented: true, live_verified: true },
      favorite_folders: { implemented: false, status: "deferred_unverified" },
    },
  };
}
action(
  program.command("capabilities").description("离线列出已实现命令与验证边界"),
  "capabilities",
  async (cmd) => {
    await context(cmd);
    return capabilities();
  },
);
action(
  program
    .command("schema [name]")
    .description("列举或导出 JSON Schema；省略name列出可用结构"),
  "schema",
  async (cmd, name) => {
    await context(cmd);
    const schemas = {
      user: userSchema,
      config: configSchema,
      challenge: publicChallengeSchema,
      note: noteSchema,
      summary: summarySchema,
      ref: refSchema,
      media: mediaSchema,
      access: accessSchema,
      profile: profileSchema,
      list: listResultSchema,
      download_item: downloadItemSchema,
      download_result: downloadResultSchema,
      error: errorSchema,
    };
    if (!name) return { schemas: Object.keys(schemas), schema_version: "1.0" };
    if (!(name in schemas))
      throw new AppError("UNKNOWN_SCHEMA", "未知 Schema 名称。", 2);
    return z.toJSONSchema(schemas[name as keyof typeof schemas]);
  },
);
action(
  program
    .command("doctor")
    .description("检查运行环境和目录，check会验证HTTP登录态")
    .option("--check", "访问平台检查登录与网络"),
  "doctor",
  async (cmd) => {
    const { service, opts } = await context(cmd);
    const status = await service.status(!!opts.check);
    return {
      node: process.version,
      runtime: process.versions.bun ? "bun" : "node",
      bun: process.versions.bun ?? null,
      platform: process.platform,
      architecture: process.arch,
      browser_required: false,
      http_only: true,
      profile: config!.profile,
      state_dir: config!.stateDir,
      authenticated: status.authenticated,
      verified: status.verified,
      protocol_version: "pc-http-2026-11",
    };
  },
);
action(
  program.command("version").description("输出程序与协议版本"),
  "version",
  async (cmd) => {
    await context(cmd);
    return {
      version,
      protocol_version: "pc-http-2026-11",
      node: process.version,
      runtime: process.versions.bun ? "bun" : "node",
      bun: process.versions.bun ?? null,
    };
  },
);
async function main() {
  try {
    if (process.argv.includes("-H") || process.argv.includes("--help-all")) {
      fullHelp();
      return;
    }
    if (process.argv.length === 2) {
      program.outputHelp();
      return;
    }
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    let app: AppError;
    if (error instanceof AppError) app = error;
    else if (error instanceof CommanderError)
      app = new AppError("INVALID_ARGUMENT", error.message, 2);
    else if (
      interrupted.signal.aborted ||
      (error as Error).name === "ExitPromptError"
    )
      app = new AppError(
        "CANCELLED",
        "操作已中断，未完成挑战可用 auth challenge 查询。",
        130,
      );
    else if (activeSignal?.aborted)
      app = new AppError("TIMEOUT", "操作整体超时。", 6);
    else if (
      typeof (error as NodeJS.ErrnoException).code === "string" &&
      /^(EACCES|EPERM|EEXIST|ENOENT|ENOSPC|EROFS)$/.test(
        (error as NodeJS.ErrnoException).code!,
      )
    )
      app = new AppError("FILESYSTEM_ERROR", "本地文件操作失败。", 8, {
        filesystem_code: (error as NodeJS.ErrnoException).code,
      });
    else
      app = new AppError("INTERNAL_ERROR", "发生内部错误。", 1, {
        error_type: (error as Error).name ?? "Error",
      });
    const body = {
      code: app.code,
      message: app.message,
      retryable: app.retryable,
      action_required: app.actionRequired,
      details: {
        ...app.details,
        ...(activeDownloadResult && !app.details.partial_result
          ? { partial_result: activeDownloadResult }
          : {}),
      } as Record<string, unknown>,
    };
    const base = {
      schema_version: "1.0",
      request_id: requestId,
      command: commandName,
    };
    if (output === "human") {
      process.stderr.write(`${app.code}: ${app.message}\n`);
      if (Object.keys(app.details).length)
        process.stderr.write(JSON.stringify(app.details) + "\n");
    } else if (output === "json")
      process.stdout.write(
        JSON.stringify({
          ...base,
          ok: false,
          data: null,
          error: body,
          meta: { transport: "http" },
        }) + "\n",
      );
    else {
      process.stdout.write(
        JSON.stringify({ ...base, type: "error", error: body }) + "\n",
      );
      process.stdout.write(
        JSON.stringify({
          ...base,
          type: "summary",
          ok: false,
          count: streamedCount,
          ...(body.details.partial_result &&
          typeof body.details.partial_result === "object"
            ? Object.fromEntries(
                Object.entries(body.details.partial_result).filter(
                  ([key]) => key !== "items",
                ),
              )
            : {}),
          error: body,
        }) + "\n",
      );
    }
    process.exitCode = app.exitCode;
  }
}
await main();

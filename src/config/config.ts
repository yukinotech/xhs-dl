import { homedir, platform } from "node:os";
import { resolve, join, dirname } from "node:path";
import { readFile, access } from "node:fs/promises";
import { parse } from "smol-toml";
import { z } from "zod";
import { AppError } from "../domain/errors.js";
const positive = z.coerce.number().finite().positive(),
  nonnegative = z.coerce.number().finite().nonnegative();
export const querySchema = z
  .object({
    limit: positive.int().default(20),
    page_size: positive.int().max(30).default(20),
    max_pages: positive.int().default(100),
    type: z.enum(["all", "image", "video"]).default("all"),
    sort: z.enum(["relevance", "latest", "likes"]).default("relevance"),
  })
  .strict();
export const downloadConfigSchema = z
  .object({
    paths: z.string().default("./downloads"),
    template: z
      .string()
      .default("{author.id}/{note.id}/{index:03}_{media.role}.{ext}"),
    timezone: z.string().default("UTC"),
    quality: z
      .string()
      .regex(/^(best|original|[1-9]\d*)$/)
      .default("best"),
    allow_quality_fallback: z.boolean().default(false),
    media: z.enum(["all", "images", "videos", "live"]).default("all"),
    concurrency: positive.int().max(32).default(3),
    rate_limit: nonnegative.default(0),
    resume: z.boolean().default(true),
    on_exists: z
      .enum(["skip", "overwrite", "error", "rename"])
      .default("error"),
    write_info_json: z.boolean().default(false),
    write_description: z.boolean().default(false),
    archive: z.string().optional(),
    dry_run: z.boolean().default(false),
  })
  .strict();
export const configSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    profile: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
      .default("default"),
    output: z
      .object({
        format: z.enum(["human", "json", "jsonl"]).optional(),
        color: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    network: z
      .object({
        request_timeout_seconds: positive.default(30),
        timeout_seconds: positive.default(300),
        proxy: z.url().optional(),
        retries: nonnegative.int().max(10).default(2),
        request_interval_ms: nonnegative.default(1000),
      })
      .strict()
      .prefault({}),
    query: querySchema.prefault({}),
    download: downloadConfigSchema.prefault({}),
  })
  .strict();
export type Config = z.infer<typeof configSchema> & {
  stateDir: string;
  configDir: string;
  configFiles: string[];
  sources?: Record<string, string>;
};
export type Options = {
  config?: string;
  configEnabled?: boolean;
  profile?: string;
  format?: string;
  proxy?: string;
  timeout?: number;
  requestTimeout?: number;
  retries?: number;
  requestInterval?: number;
  overrides?: Record<string, unknown>;
};
export function paths(env = process.env) {
  const home = homedir(),
    root =
      platform() === "win32"
        ? env.LOCALAPPDATA || join(home, "AppData", "Local")
        : platform() === "darwin"
          ? join(home, "Library", "Application Support")
          : undefined;
  return {
    configDir: resolve(
      env.XHS_DL_CONFIG_DIR ||
        (root
          ? join(root, "xhs-dl", "config")
          : join(env.XDG_CONFIG_HOME || join(home, ".config"), "xhs-dl")),
    ),
    stateDir: resolve(
      env.XHS_DL_STATE_DIR ||
        (root
          ? join(root, "xhs-dl", "state")
          : join(
              env.XDG_STATE_HOME || join(home, ".local", "state"),
              "xhs-dl",
            )),
    ),
  };
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
export const bindings: Record<
  string,
  { path: string; type: "boolean" | "number" | "string" }
> = {
  PROFILE: { path: "profile", type: "string" },
  FORMAT: { path: "output.format", type: "string" },
  COLOR: { path: "output.color", type: "boolean" },
  PROXY: { path: "network.proxy", type: "string" },
  TIMEOUT: { path: "network.timeout_seconds", type: "number" },
  REQUEST_TIMEOUT: { path: "network.request_timeout_seconds", type: "number" },
  RETRIES: { path: "network.retries", type: "number" },
  REQUEST_INTERVAL: { path: "network.request_interval_ms", type: "number" },
  LIMIT: { path: "query.limit", type: "number" },
  PAGE_SIZE: { path: "query.page_size", type: "number" },
  MAX_PAGES: { path: "query.max_pages", type: "number" },
  TYPE: { path: "query.type", type: "string" },
  SORT: { path: "query.sort", type: "string" },
  PATHS: { path: "download.paths", type: "string" },
  OUTPUT: { path: "download.template", type: "string" },
  TIMEZONE: { path: "download.timezone", type: "string" },
  QUALITY: { path: "download.quality", type: "string" },
  ALLOW_QUALITY_FALLBACK: {
    path: "download.allow_quality_fallback",
    type: "boolean",
  },
  MEDIA: { path: "download.media", type: "string" },
  CONCURRENCY: { path: "download.concurrency", type: "number" },
  RATE_LIMIT: { path: "download.rate_limit", type: "number" },
  RESUME: { path: "download.resume", type: "boolean" },
  ON_EXISTS: { path: "download.on_exists", type: "string" },
  WRITE_INFO_JSON: { path: "download.write_info_json", type: "boolean" },
  WRITE_DESCRIPTION: { path: "download.write_description", type: "boolean" },
  ARCHIVE: { path: "download.archive", type: "string" },
  DRY_RUN: { path: "download.dry_run", type: "boolean" },
};
function flatten(
  value: Record<string, unknown>,
  prefix = "",
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([k, v]) => {
      const key = prefix ? prefix + "." + k : k;
      return v && typeof v === "object" && !Array.isArray(v)
        ? Object.entries(flatten(v as Record<string, unknown>, key))
        : [[key, v]];
    }),
  );
}
function unflatten(flat: Record<string, unknown>) {
  const root: Record<string, unknown> = {};
  for (const [path, v] of Object.entries(flat)) {
    const parts = path.split(".");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts.at(-1)!] = v;
  }
  return root;
}
export async function loadConfig(options: Options = {}): Promise<Config> {
  const dirs = paths(),
    files: string[] = [],
    sources: Record<string, string> = {},
    flat = flatten(configSchema.parse({}));
  for (const key of Object.keys(flat)) sources[key] = "default";
  const assign = (key: string, v: unknown, source: string) => {
    if (v !== undefined) {
      flat[key] = v;
      sources[key] = source;
    }
  };
  if (options.configEnabled !== false) {
    const user = join(dirs.configDir, "xhs-dl.conf");
    if (await exists(user)) files.push(user);
    const found = (
      await Promise.all(
        ["xhs-dl.conf", "xhs-dl.toml"].map(async (p) =>
          (await exists(resolve(p))) ? resolve(p) : null,
        ),
      )
    ).filter((x): x is string => !!x);
    if (found.length > 1)
      throw new AppError(
        "INVALID_CONFIG",
        "当前目录同时存在 xhs-dl.conf 和 xhs-dl.toml。",
        2,
      );
    files.push(...found);
    if (options.config) files.push(resolve(options.config));
  }
  for (const file of [...new Set(files)]) {
    try {
      const value = parse(await readFile(file, "utf8")) as Record<
        string,
        unknown
      >;
      if (!configSchema.partial().safeParse(value).success)
        throw new Error("invalid config");
      for (const [key, raw] of Object.entries(flatten(value))) {
        const v =
          ["download.paths", "download.archive"].includes(key) &&
          typeof raw === "string"
            ? resolve(dirname(file), raw)
            : raw;
        assign(key, v, file);
      }
    } catch {
      throw new AppError(
        "INVALID_CONFIG",
        `无法读取或解析配置文件：${file}`,
        2,
      );
    }
  }
  for (const [key, binding] of Object.entries(bindings)) {
    const value = process.env["XHS_DL_" + key];
    if (value === undefined) continue;
    let parsed: unknown = value;
    if (binding.type === "boolean") {
      if (!["true", "false", "1", "0"].includes(value))
        throw new AppError(
          "INVALID_CONFIG",
          `XHS_DL_${key} 应为 true/false 或 1/0。`,
          2,
        );
      parsed = value === "true" || value === "1";
    }
    if (binding.type === "number") parsed = Number(value);
    assign(binding.path, parsed, "env:XHS_DL_" + key);
  }
  const flags: Record<string, unknown> = {
    profile: options.profile,
    "output.format": options.format,
    "network.proxy": options.proxy,
    "network.timeout_seconds": options.timeout,
    "network.request_timeout_seconds": options.requestTimeout,
    "network.retries": options.retries,
    "network.request_interval_ms": options.requestInterval,
    ...options.overrides,
  };
  for (const [key, value] of Object.entries(flags)) assign(key, value, "cli");
  const result = configSchema.safeParse(unflatten(flat));
  if (!result.success)
    throw new AppError("INVALID_CONFIG", "配置字段无效。", 2, {
      issues: result.error.issues.map((x) => ({
        path: x.path.join("."),
        message: x.message,
      })),
    });
  if (
    result.data.network.proxy &&
    !["http:", "https:"].includes(new URL(result.data.network.proxy).protocol)
  )
    throw new AppError("INVALID_CONFIG", "代理只支持 HTTP(S) CONNECT URL。", 2);
  try {
    new Intl.DateTimeFormat("en", {
      timeZone: result.data.download.timezone,
    }).format();
  } catch {
    throw new AppError("INVALID_CONFIG", "timezone 不是有效 IANA 时区。", 2);
  }
  return { ...result.data, ...dirs, configFiles: [...new Set(files)], sources };
}
export function redactConfig(config: Config) {
  const copy = structuredClone(config);
  if (copy.network.proxy) {
    const url = new URL(copy.network.proxy);
    url.username = "";
    url.password = "";
    copy.network.proxy = url.toString();
  }
  return copy;
}

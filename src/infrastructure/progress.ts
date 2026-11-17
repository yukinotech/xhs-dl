import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { DownloadProgress } from "../download/engine.js";

type Stream = {
  isTTY?: boolean;
  columns?: number;
  write(text: string): unknown;
  on?(event: "error", listener: () => void): unknown;
  off?(event: "error", listener: () => void): unknown;
};
type Active = { event: DownloadProgress; lastWire: number };
function bytes(n: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
function duration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const n = Math.max(0, Math.ceil(seconds));
  return n >= 3600
    ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`
    : `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}
function clean(text: string) {
  return [...stripVTControlCharacters(text)]
    .filter((char) => {
      const n = char.codePointAt(0)!;
      return n >= 32 && !(n >= 127 && n <= 159);
    })
    .join("");
}
function fit(text: string, columns: number) {
  let result = "",
    width = 0;
  for (const char of clean(text)) {
    const next = char.codePointAt(0)! > 255 ? 2 : 1;
    if (width + next > columns) break;
    result += char;
    width += next;
  }
  return result;
}

// Progress is deliberately stderr-only. A pipe gets sparse plain lines, never
// carriage returns or ANSI; a terminal gets a single refreshed aggregate bar.
export class DownloadProgressDisplay {
  enabled: boolean;
  private active = new Map<string, Active>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private visible = false;
  private lastRender = -Infinity;
  private totalWire = 0;
  private samples: Array<{ time: number; bytes: number }>;
  private readonly onError = () => {
    this.enabled = false;
    if (this.timer) clearInterval(this.timer);
  };
  constructor(
    private readonly stream: Stream,
    mode: "auto" | "always" | "never" = "auto",
    quiet = false,
    private readonly now = () => performance.now(),
  ) {
    this.enabled =
      !quiet && mode !== "never" && (mode === "always" || !!stream.isTTY);
    this.samples = [{ time: this.now(), bytes: 0 }];
    if (this.enabled) {
      stream.on?.("error", this.onError);
      this.refresh(true);
      this.timer = setInterval(() => this.refresh(), 250);
      this.timer.unref();
    }
  }
  private write(text: string) {
    try {
      this.stream.write(text);
    } catch {
      this.onError();
    }
  }
  private clear() {
    if (this.visible && this.stream.isTTY) this.write("\r\x1b[2K");
    this.visible = false;
  }
  update(event: DownloadProgress) {
    if (!this.enabled) return;
    const previous = this.active.get(event.path);
    if (!previous && !this.active.size)
      this.samples = [{ time: this.now(), bytes: this.totalWire }];
    const wire = Math.max(0, event.transferred_bytes);
    this.totalWire +=
      previous && wire >= previous.lastWire ? wire - previous.lastWire : wire;
    this.active.set(event.path, { event, lastWire: wire });
    this.refresh(!previous || previous.event.phase !== event.phase);
  }
  complete(path: string | undefined, status: string) {
    if (!this.enabled || !path) return;
    const state = this.active.get(path);
    if (!state) return;
    this.clear();
    const label =
      status === "downloaded" ? "完成" : status === "failed" ? "失败" : status;
    const size = bytes(state.event.downloaded_bytes);
    this.write(
      fit(
        `[${label}] ${basename(path)} ${size}`,
        this.stream.isTTY
          ? Math.max(10, (this.stream.columns ?? 100) - 1)
          : 200,
      ) + "\n",
    );
    this.active.delete(path);
    this.lastRender = this.now();
  }
  log(text: string) {
    this.clear();
    this.write(clean(text) + "\n");
  }
  refresh(force = false) {
    if (!this.enabled) return;
    const now = this.now();
    if (!force && now - this.lastRender < (this.stream.isTTY ? 250 : 2000))
      return;
    this.lastRender = now;
    if (this.samples.at(-1)?.time === now)
      this.samples[this.samples.length - 1] = {
        time: now,
        bytes: this.totalWire,
      };
    else this.samples.push({ time: now, bytes: this.totalWire });
    while (this.samples.length > 1 && this.samples[1]!.time < now - 5000)
      this.samples.shift();
    if (!this.active.size) {
      if (force) {
        this.clear();
        this.write(
          "准备下载：解析帖子与检查归档…" + (this.stream.isTTY ? "" : "\n"),
        );
        this.visible = !!this.stream.isTTY;
      }
      return;
    }
    const states = [...this.active.values()].map((x) => x.event);
    const downloaded = states.reduce((n, s) => n + s.downloaded_bytes, 0);
    const known = states.every((s) => s.total_bytes !== null);
    const total = known ? states.reduce((n, s) => n + s.total_bytes!, 0) : null;
    const baseline = this.samples[0]!,
      elapsed = (now - baseline.time) / 1000;
    const speed = elapsed > 0 ? (this.totalWire - baseline.bytes) / elapsed : 0;
    const verifying = states.every((s) => s.phase === "verifying");
    const phase = verifying
      ? "校验中"
      : states.some((s) => s.phase === "downloading")
        ? "下载"
        : states.some((s) => s.phase === "retrying")
          ? "重试中"
          : "连接中";
    const ratio =
      total !== null && total > 0
        ? Math.min(1, Math.max(0, downloaded / total))
        : null;
    const eta =
      total !== null && speed > 0 && !verifying
        ? Math.max(0, total - downloaded) / speed
        : null;
    const barLength =
      this.stream.isTTY && (this.stream.columns ?? 100) < 100 ? 8 : 12;
    const bar =
      ratio === null
        ? `[${"?".repeat(barLength)}]`
        : `[${"=".repeat(Math.floor(ratio * barLength))}${"-".repeat(barLength - Math.floor(ratio * barLength))}]`;
    const percent = ratio === null ? "--%" : `${(ratio * 100).toFixed(1)}%`;
    const label =
      basename(states[0]!.path) +
      (states.length > 1 ? ` (+${states.length - 1})` : "");
    const line = `${phase} ${bar} ${percent} ${bytes(downloaded).replace(" ", "")}/${total === null ? "?" : bytes(total).replace(" ", "")} | ${speed > 0 ? bytes(speed).replace(" ", "") + "/s" : "--/s"} | ETA ${duration(eta)} | ${label}`;
    this.clear();
    const visibleLine =
      this.stream.isTTY && (this.stream.columns ?? 100) < 65
        ? `${phase} ${percent} | ${speed > 0 ? bytes(speed).replace(" ", "") + "/s" : "--/s"} | ETA ${duration(eta)} | ${label}`
        : line;
    this.write(
      fit(
        visibleLine,
        this.stream.isTTY
          ? Math.max(10, (this.stream.columns ?? 100) - 1)
          : 240,
      ) + (this.stream.isTTY ? "" : "\n"),
    );
    this.visible = !!this.stream.isTTY;
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    // Never leave an unfinished carriage-return line ahead of the final result.
    this.clear();
    this.stream.off?.("error", this.onError);
    this.enabled = false;
  }
}

import { describe, expect, it } from "vitest";
import { DownloadProgressDisplay } from "../src/infrastructure/progress.js";
import type { DownloadProgress } from "../src/download/engine.js";
const base: DownloadProgress = {
  path: "/synthetic/video.mp4",
  phase: "downloading",
  downloaded_bytes: 0,
  total_bytes: 1024 * 1024,
  transferred_bytes: 0,
  resumed_bytes: 0,
  attempt: 1,
};
function fixture(
  tty = true,
  mode: "auto" | "always" | "never" = "auto",
  quiet = false,
  columns = 120,
) {
  let time = 0;
  const output: string[] = [];
  const display = new DownloadProgressDisplay(
    { isTTY: tty, columns, write: (text: string) => output.push(text) },
    mode,
    quiet,
    () => time,
  );
  return {
    display,
    output,
    setTime: (t: number) => {
      time = t;
    },
    text: () => output.join(""),
  };
}
describe("download progress output", () => {
  it("includes validated resumed bytes in percentage but excludes them from speed and ETA", () => {
    const f = fixture();
    try {
      f.display.update({
        ...base,
        downloaded_bytes: 512 * 1024,
        resumed_bytes: 512 * 1024,
      });
      f.setTime(1000);
      f.display.update({
        ...base,
        downloaded_bytes: 768 * 1024,
        resumed_bytes: 512 * 1024,
        transferred_bytes: 256 * 1024,
      });
      expect(f.text()).toContain("75.0%");
      expect(f.text()).toContain("256.0KiB/s");
      expect(f.text()).toContain("ETA 00:01");
      f.display.update({
        ...base,
        phase: "verifying",
        downloaded_bytes: 1024 * 1024,
        transferred_bytes: 512 * 1024,
      });
      expect(f.text()).toContain("校验中");
      expect(f.text()).not.toContain("[完成]");
      f.display.complete(base.path, "downloaded");
      expect(f.text()).toContain("[完成]");
    } finally {
      f.display.close();
    }
  });
  it("does not invent percentages for unknown lengths and uses sparse plain output in pipes", () => {
    const f = fixture(false, "always");
    try {
      for (let i = 0; i < 50; i++) {
        f.setTime(i * 100);
        f.display.update({
          ...base,
          total_bytes: null,
          downloaded_bytes: i * 1024,
          transferred_bytes: i * 1024,
        });
      }
      const text = f.text();
      expect(text).toContain("--%");
      expect(text).toContain("ETA --:--");
      expect(text).not.toMatch(/NaN|Infinity/);
      expect(text).not.toContain("\r");
      expect(text).not.toContain("\x1b");
      expect(text.trim().split("\n").length).toBeLessThan(8);
    } finally {
      f.display.close();
    }
  });
  it("aggregates concurrent transfers and preserves wire-byte accounting over retry resets", () => {
    const f = fixture();
    try {
      f.display.update({ ...base, total_bytes: 100 });
      f.display.update({
        ...base,
        path: "/synthetic/second.mp4",
        total_bytes: 100,
      });
      f.setTime(1000);
      f.display.update({
        ...base,
        total_bytes: 100,
        downloaded_bytes: 50,
        transferred_bytes: 50,
      });
      f.display.update({
        ...base,
        path: "/synthetic/second.mp4",
        total_bytes: 100,
        downloaded_bytes: 20,
        transferred_bytes: 20,
      });
      f.display.refresh(true);
      expect(f.text()).toContain("35.0%");
      expect(f.text()).toContain("(+1)");
      f.setTime(2000);
      f.display.update({
        ...base,
        phase: "connecting",
        total_bytes: 100,
        transferred_bytes: 0,
      });
      f.display.update({
        ...base,
        total_bytes: 100,
        downloaded_bytes: 10,
        transferred_bytes: 10,
      });
      f.display.refresh(true);
      expect(f.text()).toContain("40B/s");
    } finally {
      f.display.close();
    }
  });
  it("keeps default pipes, quiet mode and no-progress silent", () => {
    for (const f of [
      fixture(false),
      fixture(true, "never"),
      fixture(true, "always", true),
    ]) {
      f.display.update(base);
      f.display.complete(base.path, "downloaded");
      f.display.close();
      expect(f.text()).toBe("");
    }
  });
  it("sanitizes terminal control characters, handles narrow terminals and closes on failure", () => {
    const f = fixture(true, "auto", false, 48);
    try {
      const event = { ...base, path: "/synthetic/evil\x1b[31m\nvideo.mp4" };
      f.display.update(event);
      f.setTime(1000);
      f.display.update({
        ...event,
        downloaded_bytes: 1024,
        transferred_bytes: 1024,
      });
      f.display.complete(event.path, "failed");
      expect(f.text()).toContain("[失败]");
      expect(f.text()).not.toContain("\x1b[31m");
      expect(f.text()).not.toContain("evil\n");
      expect(f.text()).toContain("ETA");
      f.display.close();
      const old = f.text();
      f.setTime(10000);
      f.display.refresh(true);
      expect(f.text()).toBe(old);
    } finally {
      f.display.close();
    }
  });
});

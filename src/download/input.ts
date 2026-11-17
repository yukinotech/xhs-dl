import { readFile } from "node:fs/promises";
import { refSchema, type Ref } from "../domain/content.js";
import { AppError } from "../domain/errors.js";
import { checkSignal } from "../infrastructure/timing.js";
export async function inputRefs(
  path: string,
  format: string,
  signal?: AbortSignal,
): Promise<Array<string | Ref>> {
  if (!["urls", "jsonl"].includes(format))
    throw new AppError(
      "INVALID_ARGUMENT",
      "input-format 必须为 urls 或 jsonl。",
      2,
    );
  let text = "";
  if (path === "-") {
    const abort = () =>
      process.stdin.destroy(new AppError("CANCELLED", "批量输入已取消。", 130));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for await (const chunk of process.stdin) {
        checkSignal(signal);
        text += String(chunk);
        if (text.length > 16 * 1024 * 1024)
          throw new AppError(
            "INPUT_TOO_LARGE",
            "批量输入超过16MiB，请拆分。",
            2,
          );
      }
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  } else {
    text = await readFile(path, "utf8");
    if (text.length > 16 * 1024 * 1024)
      throw new AppError("INPUT_TOO_LARGE", "批量输入超过16MiB，请拆分。", 2);
  }
  const result: Array<string | Ref> = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (format === "urls") result.push(line.trim());
    else {
      try {
        result.push(refSchema.strict().parse(JSON.parse(line)));
      } catch {
        throw new AppError(
          "INVALID_INPUT",
          `JSONL 第 ${index + 1} 行必须是 NoteRef，不是事件 envelope。`,
          2,
        );
      }
    }
  }
  if (!result.length)
    throw new AppError("INVALID_INPUT", "批量输入没有帖子链接或 NoteRef。", 2);
  return result;
}

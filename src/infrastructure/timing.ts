import { setTimeout } from "node:timers/promises";
import { AppError } from "../domain/errors.js";
export function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new AppError(
      signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED",
      "操作已超时或中断。",
      signal.reason?.name === "TimeoutError" ? 6 : 130,
    );
}
export async function delay(ms: number, signal?: AbortSignal) {
  checkSignal(signal);
  try {
    await setTimeout(Math.max(0, ms), undefined, { signal });
  } catch {
    checkSignal(signal);
    throw new AppError("CANCELLED", "操作已中断。", 130);
  }
}

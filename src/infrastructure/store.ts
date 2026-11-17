import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { z } from "zod";
import {
  sessionSchema,
  challengeSchema,
  type Session,
  type Challenge,
} from "../domain/models.js";
import { AppError } from "../domain/errors.js";

export class Store {
  readonly dir: string;
  constructor(
    stateDir: string,
    readonly profile: string,
  ) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile))
      throw new AppError("INVALID_PROFILE", "profile 名称无效。", 2);
    this.dir = join(stateDir, "profiles", profile);
  }
  async initialize() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
  }
  async locked<T>(fn: () => Promise<T>): Promise<T> {
    await this.initialize();
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(this.dir, {
        realpath: false,
        stale: 30000,
        retries: 0,
      });
    } catch {
      throw new AppError(
        "SESSION_BUSY",
        "当前 profile 正由另一个命令使用，请稍后重试。",
        6,
      );
    }
    try {
      return await fn();
    } finally {
      await release();
    }
  }
  async read<T>(name: string, schema: z.ZodType<T>): Promise<T | null> {
    try {
      return schema.parse(
        JSON.parse(await readFile(join(this.dir, name), "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AppError(
        "STATE_INVALID",
        "本地会话或挑战状态损坏/版本不兼容。请重新登录。",
        10,
      );
    }
  }
  async write(name: string, value: unknown) {
    const target = join(this.dir, name),
      temp = join(this.dir, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temp, target);
      await chmod(target, 0o600);
    } finally {
      await rm(temp, { force: true });
    }
  }
  session() {
    return this.read("session.json", sessionSchema);
  }
  challenge() {
    return this.read("challenge.json", challengeSchema);
  }
  saveSession(session: Session) {
    return this.write("session.json", session);
  }
  saveChallenge(challenge: Challenge) {
    return this.write("challenge.json", challenge);
  }
  async clear() {
    await rm(join(this.dir, "session.json"), { force: true });
    await rm(join(this.dir, "challenge.json"), { force: true });
  }
}

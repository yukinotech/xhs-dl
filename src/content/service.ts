import { delay, checkSignal } from "../infrastructure/timing.js";
import { CookieJar } from "tough-cookie";
import { z } from "zod";
import { XhsClient, newSession, restoreJar } from "../api/client.js";
import { Store } from "../infrastructure/store.js";
import { HttpTransport } from "../infrastructure/http.js";
import { AppError } from "../domain/errors.js";
import type { Config } from "../config/config.js";
import {
  accessSchema,
  unknownAccess,
  type ListAccess,
  type Ref,
  type ListKind,
  type ListOptions,
  type Summary,
} from "../domain/content.js";
import { hash } from "./normalize.js";
import { resolveRef } from "./links.js";
import {
  userProfile,
  userPage,
  noteDetail,
  searchContext,
  searchPage,
} from "./api.js";
import { paginate } from "./paginator.js";
export class ContentService {
  readonly store: Store;
  private viewer: { id: string | null; authenticated: boolean } | undefined;
  constructor(
    readonly config: Config,
    readonly signal?: AbortSignal,
  ) {
    this.store = new Store(config.stateDir, config.profile);
  }
  async client<T>(
    fn: (client: XhsClient) => Promise<T>,
    requireLogin = false,
  ): Promise<T> {
    return this.store.locked(async () => {
      const session = (await this.store.session()) ?? newSession();
      if (requireLogin && !session.authenticated)
        throw new AppError("AUTH_REQUIRED", "该操作需要有效登录。", 3);
      if (
        this.viewer &&
        this.viewer.id !==
          (session.authenticated ? (session.user?.id ?? null) : null)
      )
        throw new AppError(
          "CURSOR_CONTEXT_MISMATCH",
          "查询期间当前 profile 的账号已改变。",
          2,
        );
      const client = new XhsClient(
        session,
        new HttpTransport(
          Object.keys(session.cookies).length
            ? await restoreJar(session)
            : new CookieJar(),
          this.config.network.request_timeout_seconds * 1000,
          this.signal,
          this.config.network.proxy,
        ),
      );
      try {
        checkSignal(this.signal);
        await delay(
          Math.max(
            0,
            this.config.network.request_interval_ms -
              (Date.now() - session.last_content_request_at),
          ),
          this.signal,
        );
        session.last_content_request_at = Date.now();
        if (!session.device.activated) await client.bootstrap();
        for (let attempt = 0; ; attempt++) {
          try {
            return await fn(client);
          } catch (error) {
            if (
              !(error instanceof AppError) ||
              !error.retryable ||
              error.exitCode === 5 ||
              attempt >= this.config.network.retries
            )
              throw error;
            await delay(Math.min(1000 * 2 ** attempt, 10000), this.signal);
          }
        }
      } catch (error) {
        if (
          error instanceof AppError &&
          ["AUTH_REQUIRED", "SESSION_EXPIRED"].includes(error.code)
        ) {
          session.authenticated = false;
          session.user = null;
        }
        throw error;
      } finally {
        await this.store.saveSession(await client.snapshot());
        await client.transport.close();
      }
    });
  }
  async identity(requireLogin = false) {
    if (this.viewer) {
      if (requireLogin && !this.viewer.authenticated)
        throw new AppError("AUTH_REQUIRED", "本人列表需要登录。", 3);
      return this.viewer;
    }
    const session = await this.store.session();
    if (!session?.authenticated) {
      if (requireLogin)
        throw new AppError("AUTH_REQUIRED", "本人列表需要登录。", 3);
      return (this.viewer = { id: null, authenticated: false });
    }
    const user = await this.client((c) => c.me(), true);
    return (this.viewer = { id: user.id, authenticated: true });
  }
  resolve(
    input: string | Ref,
    kind: "note" | "user",
    token?: string,
    source?: string,
  ) {
    return resolveRef(input, kind, {
      token,
      source,
      signal: this.signal,
      proxy: this.config.network.proxy,
      timeoutMs: this.config.network.request_timeout_seconds * 1000,
    });
  }
  async current() {
    await this.identity(true);
    const user = (await this.store.session())!.user!;
    return { ...user, ...(await this.profile("me")), id: user.id };
  }
  async target(input: string | Ref): Promise<Ref> {
    return input === "me"
      ? { id: (await this.identity(true)).id! }
      : this.resolve(input, "user");
  }
  async profile(input: string | Ref) {
    const viewer = await this.identity();
    const ref = await this.target(input);
    const profile = await this.client((c) => userProfile(c, ref, viewer.id));
    profile.list_access = await this.access(ref.id, viewer.id);
    return profile;
  }
  async note(input: string | Ref, token?: string, source?: string) {
    const ref = await this.resolve(input, "note", token, source);
    return this.client((c) =>
      noteDetail(c, ref, {
        intervalMs: this.config.network.request_interval_ms,
        signal: this.signal,
      }),
    );
  }
  private observationName(target: string, viewer: string | null) {
    return "access_" + hash({ target, viewer }) + ".json";
  }
  async access(target: string, viewer: string | null) {
    const schema = z.object({
      posts: accessSchema,
      likes: accessSchema,
      favorites: accessSchema,
    });
    const value = await this.store.read(
      this.observationName(target, viewer),
      schema,
    );
    return value
      ? (Object.fromEntries(
          Object.entries(value).map(([k, v]) => [
            k,
            { ...v, evidence: "cached_observation" },
          ]),
        ) as Record<ListKind, ListAccess>)
      : {
          posts: unknownAccess(),
          likes: unknownAccess(),
          favorites: unknownAccess(),
        };
  }
  private async observe(
    target: string,
    viewer: string | null,
    kind: ListKind,
    access: ListAccess,
  ) {
    await this.store.locked(async () => {
      const previous = await this.access(target, viewer);
      previous[kind] = access;
      await this.store.write(this.observationName(target, viewer), previous);
    });
  }
  async list(
    input: string | Ref,
    kind: ListKind,
    options: ListOptions = {},
    onItem?: (item: Summary) => Promise<void>,
    retain = true,
  ) {
    const viewer = await this.identity(input === "me");
    const target = await this.target(input);
    return paginate(
      this.store,
      {
        key: hash({
          viewer: viewer.id,
          target: target.id,
          kind,
          type: options.type ?? "all",
          pageSize: options.pageSize ?? 20,
        }),
        viewer,
        target: { id: target.id, is_self: target.id === viewer.id },
        kind,
        context: {
          target_token: target.xsec_token ?? "",
          target_source: target.xsec_source ?? "pc_user",
        },
        fetch: (cursor, size, ctx) =>
          this.client(
            (c) =>
              userPage(
                c,
                {
                  ...target,
                  xsec_token: target.xsec_token ?? ctx.target_token,
                  xsec_source: target.xsec_source ?? ctx.target_source,
                },
                kind,
                cursor,
                size,
              ),
            input === "me",
          ),
        observe: (a) => this.observe(target.id, viewer.id, kind, a),
      },
      options,
      onItem,
      retain,
    );
  }
  async search(
    keyword: string,
    options: ListOptions = {},
    onItem?: (item: Summary) => Promise<void>,
    retain = true,
  ) {
    if (!keyword.trim())
      throw new AppError("INVALID_ARGUMENT", "搜索词不能为空。", 2);
    const viewer = await this.identity();
    const context = searchContext();
    return paginate(
      this.store,
      {
        key: hash({
          viewer: viewer.id,
          keyword,
          kind: "search",
          type: options.type ?? "all",
          sort: options.sort ?? "relevance",
          pageSize: options.pageSize ?? 20,
        }),
        viewer,
        target: null,
        kind: "search",
        context,
        fetch: (cursor, size, ctx) =>
          this.client((c) =>
            searchPage(
              c,
              keyword,
              Number(cursor || 1),
              size,
              ctx as typeof context,
              options.sort,
              options.type,
            ),
          ),
      },
      options,
      onItem,
      retain,
    );
  }
  async inspectAccess(input: string | Ref, check = false) {
    const target = await this.resolve(input, "user");
    const viewer = check
      ? await this.identity()
      : {
          id: (await this.store.session())?.user?.id ?? null,
          authenticated: false,
        };
    let observed = await this.access(target.id, viewer.id);
    if (check)
      for (const kind of ["posts", "likes", "favorites"] as const) {
        try {
          await this.list(target, kind, { limit: 1, pageSize: 1, maxPages: 1 });
        } catch (e) {
          if (!(e instanceof AppError) || ![7, 11].includes(e.exitCode))
            throw e;
        }
        observed = await this.access(target.id, viewer.id);
      }
    return {
      viewer_id: viewer.id,
      target_id: target.id,
      list_access: observed,
    };
  }
}

import {
  fetch as undiciFetch,
  ProxyAgent,
  type Dispatcher,
  type RequestInit,
} from "undici";

// Bun's built-in undici shim ignores dispatchers; use its native proxy option.
// Keep proxy selection explicit so ambient proxy env vars do not change routing.
export class FetchClient {
  private readonly dispatcher: Dispatcher | undefined;
  constructor(private readonly proxy?: string) {
    if (proxy && !process.versions.bun) this.dispatcher = new ProxyAgent(proxy);
  }
  fetch(url: string | URL, options: RequestInit) {
    if (process.versions.bun) {
      return globalThis.fetch(url, {
        ...options,
        proxy: this.proxy ?? false,
      } as globalThis.RequestInit) as unknown as ReturnType<typeof undiciFetch>;
    }
    return undiciFetch(url, { ...options, dispatcher: this.dispatcher });
  }
  async close() {
    await this.dispatcher?.close();
  }
}

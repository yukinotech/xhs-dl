import { describe, it, expect } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { resolveRef } from "../src/content/links.js";
describe("short share links over HTTP", () => {
  it("expands an approved short link and retains signed access context", async () => {
    const original = getGlobalDispatcher(),
      mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    try {
      mock
        .get("https://xhslink.com")
        .intercept({ path: "/a/synthetic" })
        .reply(302, "", {
          headers: {
            location:
              "https://www.xiaohongshu.com/explore/" +
              "1".repeat(24) +
              "?xsec_token=abc%2Bdef&xsec_source=pc_share",
          },
        });
      expect(
        await resolveRef("https://xhslink.com/a/synthetic", "note"),
      ).toMatchObject({
        id: "1".repeat(24),
        xsec_token: "abc+def",
        xsec_source: "pc_share",
      });
    } finally {
      setGlobalDispatcher(original);
      await mock.close();
    }
  });
  it("rejects an unapproved redirect without following it", async () => {
    const original = getGlobalDispatcher(),
      mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    try {
      mock
        .get("https://xhslink.com")
        .intercept({ path: "/a/synthetic" })
        .reply(302, "", { headers: { location: "http://127.0.0.1/private" } });
      await expect(
        resolveRef("https://xhslink.com/a/synthetic", "note"),
      ).rejects.toMatchObject({ code: "INVALID_URL" });
    } finally {
      setGlobalDispatcher(original);
      await mock.close();
    }
  });
});

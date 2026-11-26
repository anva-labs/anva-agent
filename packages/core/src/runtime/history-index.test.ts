import { afterEach, describe, expect, it } from "vite-plus/test";
import { AnvaStore } from "../store/db.ts";
import { HistoryIndex } from "./history-index.ts";

const stores: AnvaStore[] = [];

function createTestIndex(): { readonly store: AnvaStore; readonly index: HistoryIndex } {
  const store = new AnvaStore(":memory:");
  stores.push(store);
  return { store, index: new HistoryIndex(store) };
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

describe("HistoryIndex (SQLite FTS5 trigram + CJK fallback)", () => {
  it("supports Chinese 3+ char FTS5 search, 1-2 char fallback, and ±2 context messages", () => {
    const { store, index } = createTestIndex();
    store.createAgent({ slug: "coder", name: "Coder", defaultHarness: "scripted" });
    store.createAgent({ slug: "other", name: "Other", defaultHarness: "scripted" });

    const t1 = store.createThread({ agentSlug: "coder", title: "Deploy", harness: "scripted" });
    store.insertMessage({
      agentSlug: "coder",
      threadId: t1.id,
      role: "user",
      content: "准备发布新版",
    });
    store.insertMessage({
      agentSlug: "coder",
      threadId: t1.id,
      role: "assistant",
      content: "先检查数据库迁移",
    });
    store.insertMessage({
      agentSlug: "coder",
      threadId: t1.id,
      role: "assistant",
      content: "飞书长连接配置已经保存到环境变量里",
    });
    store.insertMessage({ agentSlug: "coder", threadId: t1.id, role: "user", content: "好的谢谢" });

    // Other agent's thread must never leak into coder's search.
    const tOther = store.createThread({ agentSlug: "other", title: "Secret", harness: "scripted" });
    store.insertMessage({
      agentSlug: "other",
      threadId: tOther.id,
      role: "user",
      content: "飞书长连接配置 belongs to other",
    });

    // 3+ Chinese chars -> FTS5 trigram
    const longHits = index.search({ agentSlug: "coder", query: "长连接" });
    expect(longHits).toHaveLength(1);
    expect(longHits[0]?.threadId).toBe(t1.id);
    expect(longHits[0]?.snippet).toContain("长连接");
    expect(longHits[0]?.context.map((c) => c.content)).toEqual([
      "准备发布新版",
      "先检查数据库迁移",
      "好的谢谢",
    ]);

    // 2 Chinese chars -> instr fallback
    const shortHits = index.search({ agentSlug: "coder", query: "飞书" });
    expect(shortHits).toHaveLength(1);
    expect(shortHits[0]?.threadId).toBe(t1.id);

    // Mixed query
    const mixed = index.search({ agentSlug: "coder", query: "飞书 环境变量" });
    expect(mixed).toHaveLength(1);
  });

  it("demotes automation threads below interactive threads", () => {
    const { store, index } = createTestIndex();
    store.createAgent({ slug: "coder", name: "Coder", defaultHarness: "scripted" });

    const interactive = store.createThread({
      agentSlug: "coder",
      title: "Interactive",
      source: "cli",
      harness: "scripted",
    });
    store.insertMessage({
      agentSlug: "coder",
      threadId: interactive.id,
      role: "user",
      content: "Check deployment status",
    });

    const auto = store.createThread({
      agentSlug: "coder",
      title: "Cron",
      source: "automation",
      harness: "scripted",
    });
    store.insertMessage({
      agentSlug: "coder",
      threadId: auto.id,
      role: "assistant",
      content: "Check deployment status daily report",
    });

    const hits = index.search({ agentSlug: "coder", query: "deployment" });
    expect(hits.map((h) => h.threadId)).toEqual([interactive.id, auto.id]);

    const withoutAuto = index.search({
      agentSlug: "coder",
      query: "deployment",
      includeAutomation: false,
    });
    expect(withoutAuto.map((h) => h.threadId)).toEqual([interactive.id]);
  });

  it("truncates long messages in read() unless full is true and supports rebuild()", () => {
    const { store, index } = createTestIndex();
    store.createAgent({ slug: "coder", name: "Coder", defaultHarness: "scripted" });
    const t = store.createThread({ agentSlug: "coder", title: "Long", harness: "scripted" });
    const longText = "x".repeat(2500);
    store.insertMessage({
      agentSlug: "coder",
      threadId: t.id,
      role: "assistant",
      content: longText,
    });

    const clipped = index.read({ agentSlug: "coder", threadId: t.id });
    expect(clipped.messages[0]?.truncated).toBe(true);
    expect(clipped.messages[0]?.content.length).toBeLessThan(2100);

    const full = index.read({ agentSlug: "coder", threadId: t.id, full: true });
    expect(full.messages[0]?.truncated).toBe(false);
    expect(full.messages[0]?.content).toBe(longText);

    expect(() => index.rebuild()).not.toThrow();
  });

  it("recalls old messages beyond 80+ newer messages via full FTS5 and respects excludeThreadId", () => {
    const { store, index } = createTestIndex();
    store.createAgent({ slug: "coder", name: "Coder", defaultHarness: "scripted" });

    const oldThread = store.createThread({ agentSlug: "coder", title: "Old", harness: "scripted" });
    store.insertMessage({
      agentSlug: "coder",
      threadId: oldThread.id,
      role: "assistant",
      content: "Ancient postgres password migration playbook",
    });

    const newThread = store.createThread({ agentSlug: "coder", title: "New", harness: "scripted" });
    for (let i = 0; i < 120; i += 1) {
      store.insertMessage({
        agentSlug: "coder",
        threadId: newThread.id,
        role: "user",
        content: `Routine chatter message #${i}`,
      });
    }
    store.insertMessage({
      agentSlug: "coder",
      threadId: newThread.id,
      role: "user",
      content: "Talking briefly about postgres again",
    });

    const allHits = index.search({ agentSlug: "coder", query: "postgres" });
    expect(allHits.map((h) => h.threadId)).toContain(oldThread.id);
    expect(allHits).toHaveLength(2);

    const excluded = index.search({
      agentSlug: "coder",
      query: "postgres",
      excludeThreadId: newThread.id,
    });
    expect(excluded.map((h) => h.threadId)).toEqual([oldThread.id]);
  });
});

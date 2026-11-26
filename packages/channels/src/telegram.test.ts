import { describe, expect, it } from "vite-plus/test";
import { markdownToTelegramHtml, parseSlashCommand, splitTelegramText } from "./index.ts";

describe("telegram helpers", () => {
  it("parses slash commands and ignores plain text", () => {
    expect(parseSlashCommand("/new")).toEqual({ command: "new", args: "" });
    expect(parseSlashCommand("/MODEL@my_anva_bot gpt-5")).toEqual({
      command: "model",
      args: "gpt-5",
    });
    expect(parseSlashCommand("  /usage  ")).toEqual({ command: "usage", args: "" });
    expect(parseSlashCommand("hello /new")).toBeNull();
  });

  it("splits long text respecting paragraph and line boundaries", () => {
    const text = ["a".repeat(25), "b".repeat(25), "c".repeat(25)].join("\n\n");
    const chunks = splitTelegramText(text, 30);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
    expect(chunks.join("\n\n")).toBe(text);
  });

  it("renders markdown subsets into Telegram HTML while escaping entities safely", () => {
    const html = markdownToTelegramHtml(
      [
        "## Summary & Status",
        "",
        "Use `x < y` with **bold and *nested italic***, ~~old~~, and [Wiki](https://en.wikipedia.org/wiki/Foo_(bar)).",
        "",
        "> quoted line 1",
        "> quoted line 2",
        "",
        "- item a",
        "- item b",
        "",
        "<script>bad</script>",
        "",
        "```ts",
        "const ok = a < b && c > d;",
        "```",
      ].join("\n"),
    );

    expect(html).toContain("<b>Summary &amp; Status</b>");
    expect(html).toContain("<code>x &lt; y</code>");
    expect(html).toContain("<b>bold and <i>nested italic</i></b>");
    expect(html).toContain("<s>old</s>");
    expect(html).toContain('<a href="https://en.wikipedia.org/wiki/Foo_(bar)">Wiki</a>');
    expect(html).toContain("<blockquote>quoted line 1\nquoted line 2</blockquote>");
    expect(html).toContain("• item a\n• item b");
    expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(html).not.toContain("&amp;lt;");
    expect(html).toContain(
      '<pre><code class="language-ts">const ok = a &lt; b &amp;&amp; c &gt; d;</code></pre>',
    );
  });
});

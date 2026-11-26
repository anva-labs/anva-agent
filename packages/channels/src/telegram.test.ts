import { describe, expect, it } from "vite-plus/test";
import { parseSlashCommand } from "./index.ts";

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
});

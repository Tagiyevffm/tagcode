import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SessionController } from "../src/controller.js";
import { makeTempDir, removeDir } from "./helpers.js";

describe("model persistence", () => {
  const previousHome = process.env.TAGCODE_HOME;
  const cleanup: string[] = [];

  afterEach(async () => {
    process.env.TAGCODE_HOME = previousHome;
    while (cleanup.length > 0) await removeDir(cleanup.pop()!);
  });

  it("saves the selected model so the next launch uses it", async () => {
    const workspace = await makeTempDir("tagcode-model-ws-");
    const home = await makeTempDir("tagcode-model-home-");
    cleanup.push(workspace, home);
    process.env.TAGCODE_HOME = home;

    const first = new SessionController({ workspace });
    await first.initialize();
    await first.connectProvider("ollama", { scope: "global", model: "llama3.2" });
    await first.setModel("qwen2.5-coder:7b");
    await first.dispose();

    const configPath = path.join(home, "config.json");
    const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      defaultModel?: string;
      providers?: Array<{ id: string; defaultModel?: string }>;
    };
    expect(saved.defaultModel).toBe("qwen2.5-coder:7b");
    expect(saved.providers?.find((provider) => provider.id === "ollama")?.defaultModel).toBe(
      "qwen2.5-coder:7b",
    );

    const second = new SessionController({ workspace });
    await second.initialize();
    expect(second.getModel()).toBe("qwen2.5-coder:7b");
    await second.dispose();
  });
});

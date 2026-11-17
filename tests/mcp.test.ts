import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpManager, formatMcpContent } from "../src/mcp/manager.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { makeTempDir, makeToolContext, removeDir } from "./helpers.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-server.mjs");
const temporary: string[] = [];
const managers: McpManager[] = [];

afterEach(async () => {
  while (managers.length > 0) await managers.pop()!.disconnectAll().catch(() => undefined);
  while (temporary.length > 0) await removeDir(temporary.pop()!);
});

async function makeManager(servers: Record<string, { type: "stdio"; command: string; args?: string[] }>) {
  const projectRoot = await makeTempDir();
  temporary.push(projectRoot);
  const registry = new ToolRegistry();
  const manager = new McpManager({ servers, projectRoot, registry, defaultPermission: "sensitive" });
  managers.push(manager);
  return { manager, registry, projectRoot };
}

describe("formatMcpContent", () => {
  it("flattens text and describes binary content", () => {
    const text = formatMcpContent([
      { type: "text", text: "hello" },
      { type: "image", mimeType: "image/png", data: Buffer.alloc(400).toString("base64") },
      { type: "audio", mimeType: "audio/wav", data: "" },
      { type: "resource", resource: { uri: "file:///a.txt", text: "resource text" } },
    ]);
    expect(text).toContain("hello");
    expect(text).toContain("[image image/png");
    expect(text).toContain("[audio audio/wav");
    expect(text).toContain("resource text");
  });
});

describe("McpManager stdio integration", () => {
  it("connects, registers tools/resources, executes a tool and disconnects", async () => {
    const { manager, registry, projectRoot } = await makeManager({
      fixture: { type: "stdio", command: process.execPath, args: [fixture] },
    });

    const statuses = await manager.connectAll();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      name: "fixture",
      transport: "stdio",
      state: "connected",
      toolCount: 1,
      resourceCount: 1,
      serverName: "tagcode-test-server",
    });
    expect(registry.has("mcp__fixture__echo")).toBe(true);
    expect(manager.getToolNames("fixture")).toContain("mcp__fixture__echo");

    const { context, permissions } = await makeToolContext({ workspace: projectRoot });
    permissions.setBroker(async () => ({ approved: true, remember: true }));
    const result = await registry.execute("mcp__fixture__echo", { text: "hello" }, context);
    expect(result.ok).toBe(true);
    expect(result.output).toBe("echo:hello");

    await manager.disconnect("fixture");
    expect(manager.getStatus("fixture")?.state).toBe("disconnected");
    expect(registry.has("mcp__fixture__echo")).toBe(false);
    expect(manager.getToolNames("fixture")).toEqual([]);
  });

  it("reports connection failures without throwing", async () => {
    const { manager } = await makeManager({
      broken: { type: "stdio", command: "tagcode-definitely-missing-binary", args: [] },
    });
    const statuses = await manager.connectAll();
    expect(statuses[0]?.state).toBe("error");
    expect(statuses[0]?.error).toBeTruthy();
  });

  it("rejects unknown server names", async () => {
    const { manager } = await makeManager({});
    await expect(manager.connect("nope")).rejects.toThrow(/Unknown MCP server/);
    expect(() => manager.getStatus("nope")).not.toThrow();
    expect(manager.getStatus("nope")).toBeUndefined();
  });

  it("marks disabled servers and skips their connection", async () => {
    const { manager, registry } = await makeManager({
      off: { type: "stdio", command: process.execPath, args: [fixture] },
    });
    const disabled = new McpManager({
      servers: {
        off: { type: "stdio", command: process.execPath, args: [fixture], enabled: false },
      },
      projectRoot: await makeTempDir(),
      registry,
    });
    managers.push(disabled);
    const statuses = await disabled.connectAll();
    expect(statuses[0]?.state).toBe("disabled");
    expect(manager.getStatuses()).toHaveLength(1);
  });
});

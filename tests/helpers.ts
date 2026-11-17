import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, type ResolvedConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/agent/permissions.js";
import { SecretStore } from "../src/config/secrets.js";
import { WorkspacePaths } from "../src/security/paths.js";
import type { ToolContext } from "../src/tools/types.js";
import type { PlanController } from "../src/tools/types.js";

export async function makeTempDir(prefix = "tagcode-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeDir(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

export function testConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    permissions: { ...DEFAULT_CONFIG.permissions, ...(overrides.permissions ?? {}) },
    context: { ...DEFAULT_CONFIG.context, ...(overrides.context ?? {}) },
  };
}

export const noopPlan: PlanController = {
  get: () => undefined,
  set: () => undefined,
  updateSteps: () => undefined,
};

export type TestContextOptions = {
  workspace: string;
  home?: string;
  config?: ResolvedConfig;
  permissionMode?: "ask" | "auto" | "plan" | "yolo";
  signal?: AbortSignal;
  checkpoints?: ToolContext["checkpoints"];
};

export type TestContext = {
  context: ToolContext;
  paths: WorkspacePaths;
  permissions: PermissionManager;
  secrets: SecretStore;
  checkpoints: Array<{ paths: string[]; reason: string }>;
};

export async function makeToolContext(options: TestContextOptions): Promise<TestContext> {
  const home = options.home ?? (await makeTempDir("tagcode-home-"));
  const config = options.config ?? testConfig();
  const mode = options.permissionMode ?? "auto";
  config.permissions.mode = mode;
  const paths = await WorkspacePaths.create(options.workspace);
  const permissions = new PermissionManager(config, { auditHome: home });
  const secrets = new SecretStore({ home, backend: "file" });
  const captured: Array<{ paths: string[]; reason: string }> = [];
  const checkpoints: ToolContext["checkpoints"] = {
    capture: async (paths, reason) => {
      captured.push({ paths, reason });
      return "cp_test";
    },
  };
  const context: ToolContext = {
    workspace: options.workspace,
    projectRoot: options.workspace,
    paths,
    config,
    permissions,
    secrets,
    signal: options.signal ?? new AbortController().signal,
    sessionId: "ses_test",
    callId: "call_test",
    plan: noopPlan,
    emit: () => undefined,
    checkpoints,
  };
  return { context, paths, permissions, secrets, checkpoints: captured };
}

/** Build a Response with a streaming SSE body. */
export function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    ...init,
  });
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

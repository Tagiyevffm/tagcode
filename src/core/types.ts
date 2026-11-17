/**
 * Canonical, provider-independent types used across TagCode.
 *
 * Everything the agent engine, tools and UI exchange lives here so that
 * providers can be swapped without touching the rest of the system.
 */

export type PermissionMode = "ask" | "auto" | "plan" | "yolo";

/** Interaction mode selected by the user; independent of tool permission mode. */
export type AgentMode = "agent" | "plan" | "ask";

/** How risky an operation is. Drives the permission system. */
export type ToolPermission = "read" | "write" | "execute" | "network" | "sensitive";

export type ImagePart = {
  mimeType: string;
  /** base64 encoded image data */
  data: string;
};

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: ImagePart[] }
  | {
      role: "assistant";
      content: string;
      reasoning?: string;
      toolCalls?: ToolCall[];
    }
  | {
      role: "tool";
      /** id of the tool call this message answers */
      toolCallId: string;
      name?: string;
      content: string;
      isError?: boolean;
    };

export type ToolCall = {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
};

export type JsonSchema = Record<string, unknown>;

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type ToolResult = {
  ok: boolean;
  /** Text handed back to the model. */
  output: string;
  /** Structured data for the UI / other tools. Never sent verbatim unless small. */
  data?: unknown;
  truncated?: boolean;
  /** When true the agent loop should stop after reporting the result. */
  stop?: boolean;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type ModelInfo = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  local?: boolean;
  description?: string;
};

export type ProviderCapabilities = {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  /** Provider can enumerate models over an API. */
  modelListing: boolean;
};

export type ChatRequest = {
  model: string;
  /** System prompt; adapters place it wherever the API expects it. */
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Ask providers that support it to include reasoning summaries. */
  reasoning?: boolean;
};

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "finish"; reason: "stop" | "tool_calls" | "length" | "content_filter" | "error" };

export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  stream(request: ChatRequest): AsyncGenerator<StreamEvent>;
  listModels(): Promise<ModelInfo[]>;
}

export type ToolStartEvent = {
  type: "tool-start";
  call: ToolCall;
  permission: ToolPermission;
  summary: string;
};

export type AgentEvent =
  | { type: "assistant-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "assistant-message"; message: Extract<ChatMessage, { role: "assistant" }> }
  | ToolStartEvent
  | { type: "tool-output"; callId: string; chunk: string }
  | { type: "tool-end"; callId: string; name: string; result: ToolResult }
  | { type: "notice"; level: "info" | "warn" | "error" | "success"; text: string }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "usage"; usage: TokenUsage; cumulative: TokenUsage }
  | { type: "error"; message: string }
  | { type: "done"; reason: "completed" | "cancelled" | "max-steps" | "error" | "exit" };

export type PlanStep = {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
};

export type ApprovalRequest = {
  toolName: string;
  permission: ToolPermission;
  summary: string;
  details?: string;
  /** e.g. the exact shell command */
  command?: string;
  risk?: "low" | "medium" | "high";
};

export type ApprovalDecision = {
  approved: boolean;
  /** Remember this decision for the rest of the session. */
  remember?: boolean;
  reason?: string;
};

export type SessionPlan = {
  goal: string;
  steps: PlanStep[];
};

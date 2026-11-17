import { randomUUID } from "node:crypto";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Static,
  Text,
  useAnimation,
  useApp,
  useInput,
  usePaste,
  useWindowSize,
} from "ink";
import type {
  AgentEvent,
  AgentMode,
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  PermissionMode,
  PlanStep,
  TokenUsage,
  ToolPermission,
} from "../core/types.js";
import type { SessionController } from "../controller.js";
import { currentBranch } from "../git/repo.js";
import { NAME, VERSION } from "../version.js";
import { Markdown } from "./Markdown.js";
import { appendHistory, loadHistory } from "./history.js";
import {
  backspace,
  deleteForward,
  deleteWordBackward,
  insertText,
  isOnFirstLine,
  isOnLastLine,
  moveDown,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveUp,
  visibleLines,
  type EditResult,
} from "./editor.js";
import {
  modeColor,
  modeLabel,
  palette,
  permissionColor,
  permissionWarning,
  riskColor,
  tailLines,
  toolColor,
  truncate,
  truncateMiddle,
} from "./theme.js";

type NoticeLevel = "info" | "warn" | "error" | "success";

type TranscriptItem =
  | {
      id: string;
      kind: "banner";
      workspace: string;
      provider: string;
      model: string;
      session: string;
      mode: AgentMode;
      permission: PermissionMode;
    }
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; reasoning?: string }
  | {
      id: string;
      kind: "tool";
      name: string;
      summary: string;
      permission?: ToolPermission;
      ok?: boolean;
      output?: string;
    }
  | { id: string; kind: "notice"; level: NoticeLevel; text: string }
  | { id: string; kind: "output"; text: string }
  | { id: string; kind: "plan"; steps: PlanStep[] };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type TranscriptDraft = DistributiveOmit<TranscriptItem, "id">;

type Modal =
  | {
      kind: "approval";
      request: ApprovalRequest;
      resolve: (decision: ApprovalDecision) => void;
    }
  | { kind: "confirm"; message: string; resolve: (value: boolean) => void }
  | {
      kind: "secret";
      message: string;
      value: string;
      cursor: number;
      resolve: (value: string | undefined) => void;
    }
  | {
      kind: "ask";
      message: string;
      options?: string[];
      value: string;
      cursor: number;
      resolve: (value: string | undefined) => void;
    };

type ActiveTool = {
  callId: string;
  name: string;
  summary: string;
  permission: ToolPermission;
};

export type AppProps = {
  controller: SessionController;
  resumeLatest?: boolean;
  clearScreen: () => void;
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function makeId(): string {
  return `t_${randomUUID()}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

function bannerItem(controller: SessionController): TranscriptItem {
  return {
    id: makeId(),
    kind: "banner",
    workspace: controller.workspace,
    provider: controller.getProviderId() || "no provider",
    model: controller.getModel() || "no model",
    session: controller.sessionId,
    mode: controller.getMode(),
    permission: controller.isInitialized() ? controller.getPermissionMode() : "auto",
  };
}

function messagesToTranscript(messages: ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      items.push({ id: makeId(), kind: "user", text: message.content });
    } else if (message.role === "assistant") {
      if (message.content.trim() || message.reasoning) {
        items.push({
          id: makeId(),
          kind: "assistant",
          text: message.content,
          reasoning: message.reasoning,
        });
      }
      for (const call of message.toolCalls ?? []) {
        items.push({
          id: makeId(),
          kind: "tool",
          name: call.name,
          summary: truncate(call.arguments, 160),
          ok: undefined,
        });
      }
    } else if (message.role === "tool") {
      items.push({
        id: makeId(),
        kind: "tool",
        name: message.name ?? "tool",
        summary: message.isError ? "error" : "completed",
        ok: !message.isError,
        output: message.content,
      });
    }
  }
  return items;
}

function Banner({
  item,
  width,
}: {
  item: Extract<TranscriptItem, { kind: "banner" }>;
  width: number;
}): React.JSX.Element {
  const configured = item.provider !== "no provider" && item.model !== "no model";
  const wide = width >= 92;
  const outerWidth = Math.max(40, Math.min(112, width - 2));
  const modelText = configured ? `${item.provider}/${item.model}` : "not configured";

  const quickActions = [
    "Explain this codebase",
    "Fix a bug or a failing test",
    "Build a feature",
    "Review the current changes",
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={palette.borderStrong}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
      width={outerWidth}
    >
      <Box flexDirection={wide ? "row" : "column"}>
        <Box flexDirection="column" flexGrow={1} paddingRight={wide ? 2 : 0}>
          <Box>
            <Box flexDirection="column" marginRight={2}>
              <Text color={palette.accent}>{"  /\\_/\\"}</Text>
              <Text color={palette.accent}>{" ( ◉   ◉ )"}</Text>
              <Text color={palette.accent}>{" (   ᴗ   )"}</Text>
              <Text color={palette.accent}>{"  \\_____/"}</Text>
            </Box>
            <Box flexDirection="column">
              <Text bold color={palette.accent}>
                {NAME.toUpperCase()}
              </Text>
              <Text color={palette.text}>Your AI coding agent</Text>
              <Text color={palette.muted}>Plan. Code. Build. Together.</Text>
              <Text color={palette.faint}>v{VERSION}</Text>
            </Box>
          </Box>

          <Box
            marginTop={1}
            borderStyle="round"
            borderColor={palette.border}
            paddingX={1}
            flexDirection="column"
          >
            <Text bold color={palette.text}>
              Welcome to TagCode.
            </Text>
            <Text color={palette.muted}>What would you like to work on today?</Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            {quickActions.map((action) => (
              <Text key={action} color={palette.muted}>
                <Text color={palette.accent}>› </Text>
                {action}
              </Text>
            ))}
            <Text color={palette.faint}>
              Or just ask anything. Type <Text color={palette.accent}>/help</Text> for commands.
            </Text>
          </Box>

          {!wide ? (
            <Box marginTop={1} flexDirection="column">
              <Text color={palette.faint}>
                Directory{"  "}
                <Text color={palette.text}>{truncateMiddle(item.workspace, 56)}</Text>
              </Text>
              <Text color={palette.faint}>
                Model{"      "}
                {configured ? (
                  <Text color={palette.text}>{modelText}</Text>
                ) : (
                  <Text color={palette.accent}>not configured — run /connect</Text>
                )}
              </Text>
              <Text color={palette.faint}>
                Mode{"       "}
                <Text color={palette.text}>{modeLabel(item.mode)}</Text>
                {" · "}
                <Text color={permissionColor(item.permission)}>{item.permission}</Text>
              </Text>
            </Box>
          ) : null}
        </Box>

        {wide ? (
          <Box
            flexDirection="column"
            width={34}
            borderStyle="single"
            borderColor={palette.border}
            paddingX={1}
            paddingY={0}
          >
            <Text bold color={palette.accent}>
              Session Info
            </Text>
            <Text color={palette.faint}>{"─".repeat(20)}</Text>
            <Text color={palette.faint}>Working dir</Text>
            <Text color={palette.text} wrap="wrap">
              {truncateMiddle(item.workspace, 30)}
            </Text>
            <Box marginTop={1} flexDirection="column">
              <Text color={palette.faint}>Model</Text>
              <Text color={configured ? palette.text : palette.accent} wrap="wrap">
                {configured ? modelText : "not configured"}
              </Text>
            </Box>
            <Text color={palette.faint}>
              Mode <Text color={palette.text}>{modeLabel(item.mode)}</Text>
            </Text>
            <Text color={palette.faint}>
              Permissions <Text color={permissionColor(item.permission)}>{item.permission}</Text>
            </Text>
            <Text color={palette.faint}>
              Session <Text color={palette.muted}>{item.session ? item.session.slice(-8) : "new"}</Text>
            </Text>
            <Box marginTop={1} flexDirection="column">
              <Text bold color={palette.accent}>
                Capabilities
              </Text>
              {[
                "Read & write files",
                "Run shell commands",
                "Use Git",
                "MCP tools & skills",
                "Web with approval",
              ].map((capability) => (
                <Text key={capability} color={palette.muted}>
                  <Text color={palette.success}>✓ </Text>
                  {capability}
                </Text>
              ))}
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

function SetupCard({ width }: { width: number }): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={palette.accent}
      paddingX={2}
      paddingY={1}
      marginTop={1}
      width={Math.max(40, Math.min(100, width - 2))}
    >
      <Text bold color={palette.accent}>
        Connect a model provider
      </Text>
      <Text color={palette.muted}>
        TagCode needs a model before it can inspect files or run tools.
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={palette.text}>
          <Text color={palette.accent}>/connect anthropic</Text>
          <Text color={palette.faint}>  Claude models</Text>
        </Text>
        <Text color={palette.text}>
          <Text color={palette.accent}>/connect openai</Text>
          <Text color={palette.faint}>  GPT models</Text>
        </Text>
        <Text color={palette.text}>
          <Text color={palette.accent}>/connect ollama</Text>
          <Text color={palette.faint}>  local models, no API key</Text>
        </Text>
        <Text color={palette.text}>
          <Text color={palette.accent}>/connect custom</Text>
          <Text color={palette.faint}>  any OpenAI-compatible endpoint (guided setup)</Text>
        </Text>
      </Box>
      <Text color={palette.faint}>
        Then run <Text color={palette.accent}>/model</Text> to fetch and pick from the provider&apos;s model list.
      </Text>
    </Box>
  );
}

function NoticeRow({
  level,
  text,
}: {
  level: NoticeLevel;
  text: string;
}): React.JSX.Element {
  const color =
    level === "error"
      ? palette.error
      : level === "warn"
        ? palette.accent
        : level === "success"
          ? palette.success
          : palette.muted;
  const marker = level === "error" ? "✘" : level === "warn" ? "▲" : level === "success" ? "✔" : "•";
  return (
    <Text color={color} wrap="wrap">
      {marker} {text}
    </Text>
  );
}

function ToolRow({
  item,
  showOutput,
  width,
}: {
  item: Extract<TranscriptItem, { kind: "tool" }>;
  showOutput: boolean;
  width: number;
}): React.JSX.Element {
  const border = item.ok === false ? palette.error : item.ok === true ? palette.borderStrong : palette.border;
  const marker = item.ok === false ? "✘" : item.ok === true ? "✔" : "›";
  const markerColor = item.ok === false ? palette.error : item.ok === true ? palette.success : palette.muted;
  const preview =
    item.output && (showOutput || item.ok === false)
      ? tailLines(item.output, item.ok === false ? 14 : 8)
      : undefined;
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={border}
      paddingX={1}
      marginY={0}
      width={Math.max(24, width - 2)}
    >
      <Box>
        <Text color={markerColor}>{marker} </Text>
        <Text bold color={item.ok === false ? palette.error : palette.text}>
          {item.name}
        </Text>
        <Text color={toolColor(item.permission)}>
          {item.permission ? ` · ${item.permission}` : ""}
        </Text>
      </Box>
      {item.summary ? (
        <Text color={palette.muted} wrap="wrap">
          {truncate(item.summary, Math.max(20, width - 8))}
        </Text>
      ) : null}
      {preview ? (
        <Box flexDirection="column" marginTop={0}>
          {preview.hidden > 0 ? (
            <Text color={palette.faint}>({preview.hidden} earlier lines hidden)</Text>
          ) : null}
          <Text color={item.ok === false ? palette.error : palette.muted} wrap="wrap">
            {truncate(preview.text, 4200)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function PlanRow({ steps }: { steps: PlanStep[] }): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.accent}>
        Plan
      </Text>
      {steps.map((step) => {
        const icon =
          step.status === "completed"
            ? "✔"
            : step.status === "in_progress"
              ? "▶"
              : step.status === "blocked"
                ? "!"
                : "○";
        const color =
          step.status === "completed"
            ? palette.success
            : step.status === "in_progress"
              ? palette.accent
              : step.status === "blocked"
                ? palette.error
                : palette.muted;
        return (
          <Text key={step.id} color={color} wrap="wrap">
            {icon} {step.title}
          </Text>
        );
      })}
    </Box>
  );
}

function TranscriptRow({
  item,
  showOutput,
  width,
}: {
  item: TranscriptItem;
  showOutput: boolean;
  width: number;
}): React.JSX.Element {
  switch (item.kind) {
    case "banner":
      return <Banner item={item} width={width} />;
    case "user":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={palette.accent}>
            You
          </Text>
          <Text color={palette.text} wrap="wrap">
            {item.text}
          </Text>
        </Box>
      );
    case "assistant":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={palette.text}>
            {NAME}
          </Text>
          {item.reasoning ? (
            <Text color={palette.faint} italic wrap="wrap">
              {truncate(item.reasoning, 1800)}
            </Text>
          ) : null}
          <Markdown text={item.text || "(no text)"} />
        </Box>
      );
    case "tool":
      return <ToolRow item={item} showOutput={showOutput} width={width} />;
    case "notice":
      return <NoticeRow level={item.level} text={item.text} />;
    case "output":
      return (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor={palette.border}
          paddingX={1}
          marginY={0}
        >
          <Markdown text={item.text} color={palette.muted} />
        </Box>
      );
    case "plan":
      return <PlanRow steps={item.steps} />;
    default:
      return <Text> </Text>;
  }
}

function Spinner({ active }: { active: boolean }): React.JSX.Element {
  const { frame } = useAnimation({ interval: 80, isActive: active });
  return <Text color={palette.accent}>{SPINNER[frame % SPINNER.length]}</Text>;
}

function ModalView({ modal }: { modal: Modal }): React.JSX.Element {
  if (modal.kind === "approval") {
    const request = modal.request;
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={palette.accent}
        paddingX={1}
        marginTop={1}
      >
        <Box>
          <Text bold color={palette.accent}>
            Permission required
          </Text>
          <Text color={palette.muted}> · {request.toolName}</Text>
          <Text color={toolColor(request.permission)}> · {request.permission}</Text>
          {request.risk ? (
            <Text color={riskColor(request.risk)}> · {request.risk} risk</Text>
          ) : null}
        </Box>
        <Text color={palette.text} wrap="wrap">
          {request.summary}
        </Text>
        {request.details ? (
          <Text color={palette.muted} wrap="wrap">
            {request.details}
          </Text>
        ) : null}
        {request.command ? (
          <Box marginTop={0}>
            <Text color={palette.accent}>$ </Text>
            <Text color={palette.text} wrap="wrap">
              {request.command}
            </Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text color={palette.success}>[y] approve</Text>
          <Text color={palette.muted}> · </Text>
          <Text color={palette.accent}>[a] always this session</Text>
          <Text color={palette.muted}> · </Text>
          <Text color={palette.error}>[n] deny</Text>
        </Box>
      </Box>
    );
  }
  if (modal.kind === "confirm") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1} marginTop={1}>
        <Text color={palette.text} wrap="wrap">
          {modal.message}
        </Text>
        <Text color={palette.success}>[y] yes</Text>
        <Text color={palette.error}>[n] no</Text>
      </Box>
    );
  }
  if (modal.kind === "secret") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1} marginTop={1}>
        <Text color={palette.text}>{modal.message}</Text>
        <Text color={palette.accent}>
          {"> "}
          {"•".repeat(modal.value.length)}
          <Text inverse> </Text>
        </Text>
        <Text color={palette.faint}>Input is hidden. Enter to submit, Escape to cancel.</Text>
      </Box>
    );
  }
  const options = modal.options;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.info} paddingX={1} marginTop={1}>
      <Text color={palette.text} wrap="wrap">
        {modal.message}
      </Text>
      {options?.length ? (
        <Box flexDirection="column">
          {options.map((option, index) => (
            <Text key={`${option}-${index}`} color={palette.muted}>
              [{index + 1}] {option}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text color={palette.text}>
        {"> "}
        {modal.value}
        <Text inverse> </Text>
      </Text>
      <Text color={palette.faint}>Enter to answer, Escape to skip.</Text>
    </Box>
  );
}

export function App({ controller, resumeLatest, clearScreen }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { columns } = useWindowSize();
  const width = Math.max(40, columns || 80);

  const [epoch, setEpoch] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [initError, setInitError] = useState<string | undefined>();
  const [mode, setMode] = useState<AgentMode>(controller.getMode());
  const [permission, setPermission] = useState<PermissionMode>("auto");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [session, setSession] = useState("");
  const [usage, setUsage] = useState<TokenUsage>({ inputTokens: 0, outputTokens: 0 });
  const [context, setContext] = useState<{ estimatedTokens: number; budget: number } | undefined>();
  const [gitBranch, setGitBranch] = useState<string | undefined>();
  const [mcpSummary, setMcpSummary] = useState<string | undefined>();
  const [tick, setTick] = useState(() => Date.now());
  const [showReasoning, setShowReasoning] = useState(true);
  const [showToolOutput, setShowToolOutput] = useState(false);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [modals, setModals] = useState<Modal[]>([]);
  const [exitArmed, setExitArmed] = useState(false);

  const idRef = useRef(0);
  const streamingTextRef = useRef("");
  const streamingReasoningRef = useRef("");
  const toolMetaRef = useRef(new Map<string, { summary: string; permission: ToolPermission }>());
  const historyRef = useRef<string[]>([]);
  const historyPosRef = useRef<number | undefined>(undefined);
  const draftRef = useRef("");
  const completionRef = useRef<{ base: string; index: number } | undefined>(undefined);
  const armedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const initializedRef = useRef(false);

  const modal = modals[0];

  const append = useCallback((draft: TranscriptDraft) => {
    idRef.current += 1;
    setTranscript((previous) => [
      ...previous,
      { ...(draft as Omit<TranscriptItem, "id">), id: `t_${idRef.current}` } as TranscriptItem,
    ]);
  }, []);

  const syncStatus = useCallback(() => {
    setMode(controller.getMode());
    if (controller.isInitialized()) {
      setPermission(controller.getPermissionMode());
      setProvider(controller.getProviderId());
      setModel(controller.getModel());
      setSession(controller.sessionId);
    }
    setUsage(controller.getUsage());
    const stats = controller.getContextStats();
    setContext(stats ? { estimatedTokens: stats.estimatedTokens, budget: stats.budget } : undefined);
    const mcpStatuses = controller.getMcpManager()?.getStatuses() ?? [];
    setMcpSummary(
      mcpStatuses.length > 0
        ? `mcp ${mcpStatuses.filter((status) => status.state === "connected").length}/${mcpStatuses.length}`
        : undefined,
    );
    void currentBranch(controller.workspace)
      .then((branch) => setGitBranch(branch))
      .catch(() => setGitBranch(undefined));
  }, [controller]);

  const resetView = useCallback(() => {
    clearScreen();
    setEpoch((value) => value + 1);
    setTranscript([
      bannerItem(controller),
      ...messagesToTranscript(controller.getMessages()),
    ]);
    setStreamingText("");
    setStreamingReasoning("");
    streamingTextRef.current = "";
    streamingReasoningRef.current = "";
    setActiveTools([]);
  }, [clearScreen, controller]);

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case "assistant-delta":
          streamingTextRef.current += event.text;
          setStreamingText(streamingTextRef.current);
          break;
        case "reasoning-delta":
          streamingReasoningRef.current += event.text;
          setStreamingReasoning(streamingReasoningRef.current);
          break;
        case "assistant-message":
          append({
            kind: "assistant",
            text: event.message.content,
            reasoning: event.message.reasoning,
          });
          streamingTextRef.current = "";
          streamingReasoningRef.current = "";
          setStreamingText("");
          setStreamingReasoning("");
          break;
        case "tool-start": {
          toolMetaRef.current.set(event.call.id, {
            summary: event.summary,
            permission: event.permission,
          });
          setActiveTools((previous) => [
            ...previous,
            {
              callId: event.call.id,
              name: event.call.name,
              summary: event.summary,
              permission: event.permission,
            },
          ]);
          break;
        }
        case "tool-end": {
          const meta = toolMetaRef.current.get(event.callId);
          toolMetaRef.current.delete(event.callId);
          setActiveTools((previous) => previous.filter((tool) => tool.callId !== event.callId));
          append({
            kind: "tool",
            name: event.name,
            summary: meta?.summary ?? "completed",
            permission: meta?.permission,
            ok: event.result.ok,
            output: event.result.output,
          });
          break;
        }
        case "notice":
          append({ kind: "notice", level: event.level, text: event.text });
          break;
        case "plan":
          append({ kind: "plan", steps: event.steps });
          break;
        case "usage":
          setUsage(event.cumulative);
          break;
        case "error":
          append({ kind: "notice", level: "error", text: event.message });
          break;
        case "done":
          if (streamingTextRef.current.trim()) {
            append({
              kind: "assistant",
              text: streamingTextRef.current,
              reasoning: streamingReasoningRef.current || undefined,
            });
          }
          streamingTextRef.current = "";
          streamingReasoningRef.current = "";
          setStreamingText("");
          setStreamingReasoning("");
          setActiveTools([]);
          setBusy(false);
          syncStatus();
          break;
        default:
          break;
      }
    },
    [append, syncStatus],
  );

  useEffect(() => controller.onEvent(handleEvent), [controller, handleEvent]);

  useEffect(() => {
    void loadHistory().then((entries) => {
      historyRef.current = entries;
      setHistory(entries);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const enqueue = (value: Modal): void => {
      setModals((previous) => [...previous, value]);
    };

    controller.setUiHooks({
      requestSecret: (message) =>
        new Promise<string | undefined>((resolve) =>
          enqueue({ kind: "secret", message, value: "", cursor: 0, resolve }),
        ),
      confirm: (message) =>
        new Promise<boolean>((resolve) => enqueue({ kind: "confirm", message, resolve })),
      requestInput: (message, options) =>
        new Promise<string | undefined>((resolve) =>
          enqueue({ kind: "ask", message, options, value: "", cursor: 0, resolve }),
        ),
    });
    controller.setApprovalBroker(
      (request) =>
        new Promise<ApprovalDecision>((resolve) =>
          enqueue({ kind: "approval", request, resolve }),
        ),
    );

    void (async () => {
      try {
        const report = await controller.initialize();
        if (cancelled) return;
        initializedRef.current = true;
        if (resumeLatest) {
          try {
            await controller.loadSession("latest");
          } catch (error) {
            append({
              kind: "notice",
              level: "warn",
              text: `Could not resume the latest session: ${(error as Error).message}`,
            });
          }
        }
        setShowReasoning(controller.config.ui.showReasoning);
        setShowToolOutput(controller.config.ui.showToolOutput);
        setProvider(report.provider ?? controller.getProviderId());
        setModel(report.model ?? controller.getModel());
        setSession(controller.sessionId);
        setTranscript((previous) => {
          if (previous.some((item) => item.kind === "banner")) return previous;
          return [
            bannerItem(controller),
            ...messagesToTranscript(controller.getMessages()),
            ...previous,
          ];
        });
        syncStatus();
      } catch (error) {
        if (cancelled) return;
        const message = (error as Error).message;
        setInitError(message);
        append({ kind: "notice", level: "error", text: `Initialization failed: ${message}` });
      } finally {
        if (!cancelled) setInitializing(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.setApprovalBroker(undefined);
    };
  }, [append, controller, resumeLatest, syncStatus]);

  useEffect(() => {
    return () => {
      if (armedTimerRef.current) clearTimeout(armedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 30_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, []);

  const commands = useMemo(() => {
    if (!controller.isInitialized()) return [];
    const builtins = controller
      .getCommandRegistry()
      .list()
      .map((definition) => ({ name: definition.name, description: definition.description }));
    const plugins = (controller.getPluginHost()?.getCommands() ?? []).map((entry) => ({
      name: `plugin:${entry.key}`,
      description: entry.command.description,
    }));
    return [...builtins, ...plugins];
  }, [controller, initializing]);

  const suggestions = useMemo(() => {
    if (modal || !input.startsWith("/") || /\s/.test(input)) return [];
    const query = input.slice(1).toLowerCase();
    return commands.filter((command) => command.name.toLowerCase().startsWith(query)).slice(0, 8);
  }, [commands, input, modal]);

  const armExit = useCallback(() => {
    setExitArmed(true);
    if (armedTimerRef.current) clearTimeout(armedTimerRef.current);
    armedTimerRef.current = setTimeout(() => setExitArmed(false), 2000);
  }, []);

  const quit = useCallback(() => {
    if (controller.isRunning()) controller.cancel();
    exit();
  }, [controller, exit]);

  const applyEdit = useCallback((result: EditResult) => {
    setInput(result.value);
    setCursor(result.cursor);
  }, []);

  const addToModal = useCallback((text: string) => {
    setModals((previous) => {
      if (previous.length === 0) return previous;
      const [first, ...rest] = previous;
      if (!first || (first.kind !== "secret" && first.kind !== "ask")) return previous;
      const next = insertText(first.value, first.cursor, text);
      return [{ ...first, value: next.value, cursor: next.cursor }, ...rest];
    });
  }, []);

  usePaste((text) => {
    if (modals.length > 0) {
      addToModal(text);
      return;
    }
    if (initializing) return;
    applyEdit(insertText(input, cursor, text));
  });

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text || initializing) return;
    if (busy || controller.isRunning()) {
      append({
        kind: "notice",
        level: "warn",
        text: "The agent is still running. Press Ctrl+C to cancel before sending another message.",
      });
      return;
    }
    setInput("");
    setCursor(0);
    historyPosRef.current = undefined;
    completionRef.current = undefined;
    streamingTextRef.current = "";
    streamingReasoningRef.current = "";
    setStreamingText("");
    setStreamingReasoning("");
    setBusy(true);
    append({ kind: "user", text });

    if (text.startsWith("/")) {
      try {
        const result = await controller.executeCommand(text);
        if (result.resetView) resetView();
        if (result.output) append({ kind: "output", text: result.output });
        syncStatus();
        if (result.exit) {
          quit();
          return;
        }
      } catch (error) {
        append({ kind: "notice", level: "error", text: (error as Error).message });
      } finally {
        setBusy(false);
      }
      return;
    }

    const nextHistory = [...historyRef.current, text];
    historyRef.current = nextHistory;
    setHistory(nextHistory);
    void appendHistory(text);
    try {
      await controller.run(text);
    } catch (error) {
      append({ kind: "notice", level: "error", text: (error as Error).message });
    } finally {
      streamingTextRef.current = "";
      streamingReasoningRef.current = "";
      setStreamingText("");
      setStreamingReasoning("");
      setActiveTools([]);
      setBusy(false);
      syncStatus();
    }
  }, [append, busy, controller, initializing, input, quit, resetView, syncStatus]);

  const resolveApproval = useCallback(
    (current: Extract<Modal, { kind: "approval" }>, approved: boolean, remember = false) => {
      current.resolve({ approved, remember });
      setModals((previous) => previous.slice(1));
    },
    [],
  );

  const handleModalInput = useCallback(
    (value: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
      if (!modal) return;
      if (key.ctrl && value === "c") {
        if (modal.kind === "approval") resolveApproval(modal, false);
        else if (modal.kind === "confirm") {
          modal.resolve(false);
          setModals((previous) => previous.slice(1));
        } else {
          modal.resolve(undefined);
          setModals((previous) => previous.slice(1));
        }
        return;
      }
      if (modal.kind === "approval") {
        if (value.toLowerCase() === "y" || key.return) resolveApproval(modal, true);
        else if (value.toLowerCase() === "a") resolveApproval(modal, true, true);
        else if (value.toLowerCase() === "n" || key.escape) resolveApproval(modal, false);
        return;
      }
      if (modal.kind === "confirm") {
        if (value.toLowerCase() === "y" || key.return) {
          modal.resolve(true);
          setModals((previous) => previous.slice(1));
        } else if (value.toLowerCase() === "n" || key.escape) {
          modal.resolve(false);
          setModals((previous) => previous.slice(1));
        }
        return;
      }
      if (key.escape) {
        modal.resolve(undefined);
        setModals((previous) => previous.slice(1));
        return;
      }
      let next: EditResult = { value: modal.value, cursor: modal.cursor };
      if (key.return) {
        const answer = modal.value.trim();
        if (modal.kind === "ask" && modal.options?.length && /^\d+$/.test(answer)) {
          const selected = modal.options[Number(answer) - 1];
          modal.resolve(selected ?? answer);
        } else {
          modal.resolve(answer || (modal.kind === "secret" ? undefined : ""));
        }
        setModals((previous) => previous.slice(1));
        return;
      }
      if (key.backspace) next = backspace(next.value, next.cursor);
      else if (key.delete) next = deleteForward(next.value, next.cursor);
      else if (key.ctrl && value === "w") next = deleteWordBackward(next.value, next.cursor);
      else if (key.leftArrow) next = moveLeft(next.value, next.cursor);
      else if (key.rightArrow) next = moveRight(next.value, next.cursor);
      else if (key.home) next = moveLineStart(next.value, next.cursor);
      else if (key.end) next = moveLineEnd(next.value, next.cursor);
      else if (value && !key.ctrl && !key.meta) next = insertText(next.value, next.cursor, value);
      setModals((previous) => {
        if (previous.length === 0) return previous;
        const [first, ...rest] = previous;
        if (!first || (first.kind !== "secret" && first.kind !== "ask")) return previous;
        return [{ ...first, value: next.value, cursor: next.cursor }, ...rest];
      });
    },
    [modal, resolveApproval],
  );

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      if (modal) {
        handleModalInput(value, key);
        return;
      }
      if (busy || controller.isRunning()) {
        controller.cancel();
        append({ kind: "notice", level: "info", text: "Cancelling the active run…" });
        return;
      }
      if (input.length > 0) {
        setInput("");
        setCursor(0);
        historyPosRef.current = undefined;
        return;
      }
      if (exitArmed) {
        quit();
        return;
      }
      armExit();
      return;
    }

    if (modal) {
      handleModalInput(value, key);
      return;
    }

    if (key.ctrl && value === "d") {
      if (!busy && input.length === 0) quit();
      return;
    }

    if (initializing) return;

    if (key.escape) {
      if (busy || controller.isRunning()) {
        controller.cancel();
        append({ kind: "notice", level: "info", text: "Cancelling the active run…" });
      }
      return;
    }

    if (key.return) {
      if (key.shift || key.ctrl || value === "\n") {
        applyEdit(insertText(input, cursor, "\n"));
        return;
      }
      void submit();
      return;
    }

    if (key.tab) {
      let base: string | undefined;
      let index = 0;
      const active = completionRef.current;
      if (active) {
        base = active.base;
        index = active.index + 1;
      } else if (input.startsWith("/") && !/\s/.test(input)) {
        base = input.slice(1);
        index = 0;
      }
      if (!base) return;
      const list = commands
        .filter((command) => command.name.toLowerCase().startsWith(base!.toLowerCase()))
        .slice(0, 8);
      if (list.length === 0) return;
      const choice = list[index % list.length]!;
      completionRef.current = { base, index };
      setInput(`/${choice.name}`);
      setCursor(choice.name.length + 1);
      historyPosRef.current = undefined;
      return;
    }

    if (key.upArrow) {
      if (isOnFirstLine(input, cursor) && historyRef.current.length > 0) {
        const list = historyRef.current;
        if (historyPosRef.current === undefined) {
          draftRef.current = input;
          historyPosRef.current = list.length;
        }
        const nextPos = Math.max(0, historyPosRef.current - 1);
        historyPosRef.current = nextPos;
        const nextValue = list[nextPos] ?? draftRef.current;
        setInput(nextValue);
        setCursor(nextValue.length);
        return;
      }
      applyEdit(moveUp(input, cursor));
      return;
    }

    if (key.downArrow) {
      if (isOnLastLine(input, cursor) && historyPosRef.current !== undefined) {
        const list = historyRef.current;
        const nextPos = historyPosRef.current + 1;
        historyPosRef.current = nextPos >= list.length ? undefined : nextPos;
        const nextValue = nextPos >= list.length ? draftRef.current : list[nextPos]!;
        setInput(nextValue);
        setCursor(nextValue.length);
        return;
      }
      applyEdit(moveDown(input, cursor));
      return;
    }

    if (key.leftArrow) {
      applyEdit(key.ctrl ? moveLineStart(input, cursor) : moveLeft(input, cursor));
      return;
    }
    if (key.rightArrow) {
      applyEdit(key.ctrl ? moveLineEnd(input, cursor) : moveRight(input, cursor));
      return;
    }
    if (key.home) {
      applyEdit(moveLineStart(input, cursor));
      return;
    }
    if (key.end) {
      applyEdit(moveLineEnd(input, cursor));
      return;
    }
    if (key.backspace) {
      applyEdit(key.ctrl ? deleteWordBackward(input, cursor) : backspace(input, cursor));
      historyPosRef.current = undefined;
      completionRef.current = undefined;
      return;
    }
    if (key.delete) {
      applyEdit(deleteForward(input, cursor));
      historyPosRef.current = undefined;
      return;
    }
    if (value && !key.ctrl && !key.meta) {
      applyEdit(insertText(input, cursor, value));
      historyPosRef.current = undefined;
      completionRef.current = undefined;
    }
  });

  const contextPercent = context
    ? Math.round((context.estimatedTokens / Math.max(1, context.budget)) * 100)
    : undefined;
  const warning = permissionWarning(permission);

  const shownInput = visibleLines(input, cursor, 8);
  const inputLines = shownInput.text.split("\n");
  const localCursor = cursor - shownInput.offset;

  let lineOffset = 0;
  const renderedLines = inputLines.map((line, index) => {
    const lineStart = lineOffset;
    const lineEnd = lineOffset + line.length;
    lineOffset = lineEnd + 1;
    const hasCursor = localCursor >= lineStart && localCursor <= lineEnd;
    const column = hasCursor ? localCursor - lineStart : -1;
    const before = hasCursor ? line.slice(0, column) : line;
    const at = hasCursor ? line[column] ?? " " : "";
    const after = hasCursor ? line.slice(column + 1) : "";
    return (
      <Box key={`line-${index}`}>
        <Text color={index === 0 ? palette.accent : palette.faint}>{index === 0 ? "› " : "  "}</Text>
        <Text color={palette.text} wrap="wrap">
          {before}
          {hasCursor ? (
            <Text inverse color={palette.accent}>
              {at}
            </Text>
          ) : null}
          {after}
          {!input && index === 0 ? (
            <Text color={palette.faint}>Describe a task, ask a question, or type /help</Text>
          ) : null}
        </Text>
      </Box>
    );
  });

  const streamingPreview = tailLines(streamingText, 16);
  const reasoningPreview = tailLines(streamingReasoning, 6);
  const active = busy || controller.isRunning();
  const sessionStartedAt = controller.isInitialized()
    ? Date.parse(controller.getSession().createdAt)
    : Number.NaN;
  const duration = Number.isFinite(sessionStartedAt) ? formatDuration(tick - sessionStartedAt) : undefined;

  return (
    <Box flexDirection="column" key={epoch} paddingX={1}>
      <Static items={transcript}>
        {(item) => (
          <Box key={item.id} flexDirection="column">
            <TranscriptRow item={item} showOutput={showToolOutput} width={width - 2} />
          </Box>
        )}
      </Static>

      {initializing ? (
        <Box>
          <Spinner active />
          <Text color={palette.muted}> Starting TagCode…</Text>
        </Box>
      ) : null}

      {initError ? (
        <Text color={palette.error} wrap="wrap">
          ✘ {initError}
        </Text>
      ) : null}

      {!initializing && !initError && controller.isInitialized() && !provider ? (
        <SetupCard width={width - 2} />
      ) : null}

      {showReasoning && reasoningPreview.text ? (
        <Box flexDirection="column" marginTop={0}>
          <Text color={palette.faint} italic>
            thinking
          </Text>
          {reasoningPreview.hidden > 0 ? (
            <Text color={palette.faint}>({reasoningPreview.hidden} earlier lines hidden)</Text>
          ) : null}
          <Text color={palette.faint} italic wrap="wrap">
            {reasoningPreview.text}
          </Text>
        </Box>
      ) : null}

      {streamingPreview.text ? (
        <Box flexDirection="column" marginTop={0}>
          <Text bold color={palette.text}>
            {NAME}
          </Text>
          {streamingPreview.hidden > 0 ? (
            <Text color={palette.faint}>({streamingPreview.hidden} earlier lines hidden)</Text>
          ) : null}
          <Text color={palette.text} wrap="wrap">
            {streamingPreview.text}
          </Text>
        </Box>
      ) : null}

      {activeTools.map((tool) => (
        <Box key={tool.callId}>
          <Spinner active />
          <Text bold color={palette.text}>
            {" "}
            {tool.name}
          </Text>
          <Text color={toolColor(tool.permission)}> · {tool.permission}</Text>
          <Text color={palette.muted} wrap="wrap">
            {" "}
            {truncate(tool.summary, Math.max(24, width - 24))}
          </Text>
        </Box>
      ))}

      {suggestions.length > 0 ? (
        <Box flexDirection="column" marginTop={0}>
          {suggestions.map((suggestion) => (
            <Text key={suggestion.name} color={palette.muted} wrap="truncate-end">
              <Text color={palette.accent}>/{suggestion.name}</Text>
              {"  "}
              {truncate(suggestion.description, Math.max(16, width - suggestion.name.length - 6))}
            </Text>
          ))}
          <Text color={palette.faint}>Tab completes · Enter sends</Text>
        </Box>
      ) : null}

      {modal ? <ModalView modal={modal} /> : null}

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={modal ? palette.faint : active ? palette.accent : palette.borderStrong}
        paddingX={1}
        marginTop={1}
      >
        {shownInput.hidden > 0 ? (
          <Text color={palette.faint}>… {shownInput.hidden} earlier line(s)</Text>
        ) : null}
        {renderedLines}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={palette.border}>{"─".repeat(Math.max(10, width - 4))}</Text>
        <Box justifyContent="space-between">
          <Box>
            <Text backgroundColor={modeColor(mode)} color={palette.background} bold>
              {" "}{modeLabel(mode)}{" "}
            </Text>
            <Text color={palette.faint}> </Text>
            <Text color={permissionColor(permission)}>{permission}</Text>
            <Text color={palette.faint}>  </Text>
            <Text color={provider && model ? palette.text : palette.accent}>
              {truncate(
                provider && model ? `${provider}/${model}` : "no provider — run /connect",
                Math.max(20, width - 52),
              )}
            </Text>
          </Box>
          <Box>
            {gitBranch ? (
              <Text color={palette.faint}>
                ⑂ {truncate(gitBranch, 16)}
                {"  "}
              </Text>
            ) : null}
            {contextPercent !== undefined ? (
              <Text color={contextPercent > 85 ? palette.error : palette.faint}>
                ctx {contextPercent}%{"  "}
              </Text>
            ) : null}
            {usage.inputTokens + usage.outputTokens > 0 ? (
              <Text color={palette.faint}>
                {usage.inputTokens + usage.outputTokens} tok{"  "}
              </Text>
            ) : null}
            {active ? <Spinner active /> : null}
          </Box>
        </Box>
        <Box>
          <Text color={palette.faint}>session {session ? session.slice(-8) : "—"}</Text>
          {mcpSummary ? <Text color={palette.faint}>{`  ·  ${mcpSummary}`}</Text> : null}
          {duration ? <Text color={palette.faint}>{`  ·  ${duration}`}</Text> : null}
        </Box>
        {warning ? <Text color={palette.accent}>▲ {warning}</Text> : null}
        {exitArmed ? (
          <Text color={palette.accent}>Press Ctrl+C again to exit.</Text>
        ) : (
          <Text color={palette.faint}>
            {active
              ? "Ctrl+C cancels · Enter sends after the run finishes"
              : "Enter send · Shift+Enter/Ctrl+J newline · ↑ history · /help commands"}
          </Text>
        )}
      </Box>
    </Box>
  );
}

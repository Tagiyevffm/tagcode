/* TagCode Desktop renderer — no build step, no external dependencies. */
(() => {
  "use strict";

  const token = document.querySelector('meta[name="tagcode-token"]').content;
  const $ = (id) => document.getElementById(id);
  const el = {
    workspace: $("workspace"),
    modelPill: $("model-pill"),
    connectBtn: $("connect-btn"),
    settingsBtn: $("settings-btn"),
    updatePill: $("update-pill"),
    welcome: $("welcome"),
    setupBanner: $("setup-banner"),
    messages: $("messages"),
    conversation: $("conversation"),
    input: $("input"),
    sendBtn: $("send-btn"),
    stopBtn: $("stop-btn"),
    modeBadge: $("mode-badge"),
    permissionLabel: $("permission-label"),
    composerModel: $("composer-model"),
    statusline: $("statusline"),
    modalRoot: $("modal-root"),
    toastRoot: $("toast-root"),
    infoWorkspace: $("info-workspace"),
    infoModel: $("info-model"),
    infoMode: $("info-mode"),
    infoPermission: $("info-permission"),
    infoSession: $("info-session"),
    infoBranch: $("info-branch"),
    infoContext: $("info-context"),
    infoTokens: $("info-tokens"),
    infoMcp: $("info-mcp"),
    infoSkills: $("info-skills"),
    contextFill: $("context-fill"),
    newSessionBtn: $("new-session-btn"),
    undoBtn: $("undo-btn"),
    mascot: $("mascot"),
    mcpList: $("mcp-list"),
    mcpSummary: $("mcp-summary"),
    mcpTabCount: $("mcp-tab-count"),
    skillsTabCount: $("skills-tab-count"),
    skillList: $("skill-list"),
    skillSearch: $("skill-search"),
    mcpCatalogBtn: $("mcp-catalog-btn"),
    skillCatalogBtn: $("skill-catalog-btn"),
    commandMenu: $("command-menu"),
  };

  const PROVIDERS = {
    anthropic: {
      label: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
      key: true,
    },
    openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", key: true },
    openrouter: {
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-4.1",
      key: true,
    },
    deepseek: {
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      key: true,
    },
    mistral: {
      label: "Mistral",
      baseUrl: "https://api.mistral.ai/v1",
      model: "mistral-large-latest",
      key: true,
    },
    groq: {
      label: "Groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
      key: true,
    },
    together: {
      label: "Together AI",
      baseUrl: "https://api.together.xyz/v1",
      model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      key: true,
    },
    fireworks: {
      label: "Fireworks AI",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      model: "accounts/fireworks/models/llama-v3p3-70b-instruct",
      key: true,
    },
    ollama: {
      label: "Ollama (local)",
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5-coder:7b",
      key: false,
    },
    custom: {
      label: "Custom OpenAI-compatible",
      baseUrl: "http://localhost:8000/v1",
      model: "",
      key: false,
    },
  };

  const state = {
    data: null,
    streaming: "",
    reasoning: "",
    running: false,
    activeTools: new Map(),
    plan: null,
    durationTimer: null,
    events: null,
    toolStartedAt: new Map(),
    lastMcpSignature: "",
    lastSkillsSignature: "",
    commandIndex: 0,
    commandResults: [],
    mascotLockedUntil: 0,
    update: null,
    activeTab: "session",
  };

  function setMascot(mode, holdMs = 0) {
    const now = Date.now();
    if (holdMs === 0 && now < state.mascotLockedUntil) return;
    state.mascotLockedUntil = holdMs > 0 ? now + holdMs : 0;
    el.mascot.classList.remove(
      "is-thinking",
      "is-working",
      "is-success",
      "is-error",
      "is-plan",
      "is-talking",
    );
    if (mode && mode !== "idle") el.mascot.classList.add(`is-${mode}`);
    if (holdMs > 0) {
      setTimeout(() => {
        if (Date.now() >= state.mascotLockedUntil) {
          setMascot(state.data?.mode === "plan" ? "plan" : "idle");
        }
      }, holdMs + 30);
    }
  }

  async function api(path, options = {}) {
    const headers = { "X-TagCode-Token": token, ...(options.headers || {}) };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(path, {
      ...options,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function inlineFormat(value) {
    return escapeHtml(value)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  function renderMarkdown(text) {
    const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let code = null;
    let list = null;
    const closeList = () => {
      if (list) {
        out.push(`</${list}>`);
        list = null;
      }
    };
    for (const line of lines) {
      const fence = /^```[\w.+-]*\s*$/.exec(line);
      if (fence) {
        if (code !== null) {
          out.push(`<div class="code-block"><button class="code-copy" type="button">copy</button><pre><code>${escapeHtml(code.join("\n"))}</code></pre></div>`);
          code = null;
        } else {
          closeList();
          code = [];
        }
        continue;
      }
      if (code !== null) {
        code.push(line);
        continue;
      }
      if (!line.trim()) {
        closeList();
        continue;
      }
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        closeList();
        const level = heading[1].length;
        out.push(`<h${level}>${inlineFormat(heading[2])}</h${level}>`);
        continue;
      }
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) {
        if (list !== "ul") {
          closeList();
          out.push("<ul>");
          list = "ul";
        }
        out.push(`<li>${inlineFormat(bullet[1])}</li>`);
        continue;
      }
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (numbered) {
        if (list !== "ol") {
          closeList();
          out.push("<ol>");
          list = "ol";
        }
        out.push(`<li>${inlineFormat(numbered[1])}</li>`);
        continue;
      }
      closeList();
      out.push(`<p>${inlineFormat(line)}</p>`);
    }
    if (code !== null) out.push(`<div class="code-block"><button class="code-copy" type="button">copy</button><pre><code>${escapeHtml(code.join("\n"))}</code></pre></div>`);
    closeList();
    return out.join("");
  }

  function toast(message, level = "info") {
    const node = document.createElement("div");
    node.className = `toast ${level}`;
    node.textContent = message;
    el.toastRoot.appendChild(node);
    setTimeout(() => node.remove(), 5200);
  }

  function scrollToBottom(force = false) {
    const c = el.conversation;
    const near = c.scrollHeight - c.scrollTop - c.clientHeight < 180;
    if (force || near) c.scrollTop = c.scrollHeight;
  }

  function welcomeVisible() {
    return el.messages.children.length === 0 && !state.streaming && !state.running;
  }

  function syncWelcome() {
    el.welcome.classList.toggle("hidden", !welcomeVisible());
  }

  function nowTime() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function appendUser(text) {
    const node = document.createElement("div");
    node.className = "msg msg-user";
    node.textContent = text;
    el.messages.appendChild(node);
    syncWelcome();
    scrollToBottom(true);
  }

  function appendAssistant(text, reasoning) {
    const node = document.createElement("div");
    node.className = "msg msg-assistant";
    const label = document.createElement("div");
    label.className = "msg-label";
    label.innerHTML = `<span>TagCode</span><span class="time">${nowTime()}</span>`;
    node.appendChild(label);
    if (reasoning) {
      const think = document.createElement("div");
      think.className = "thinking";
      think.textContent = reasoning;
      node.appendChild(think);
    }
    const body = document.createElement("div");
    body.className = "markdown";
    body.innerHTML = renderMarkdown(text || (reasoning ? "" : "(no text)"));
    if (body.innerHTML) node.appendChild(body);
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    const copy = document.createElement("button");
    copy.className = "msg-action";
    copy.textContent = "copy";
    copy.addEventListener("click", () => {
      void copyText(text || reasoning || "");
      copy.textContent = "copied";
      setTimeout(() => (copy.textContent = "copy"), 1400);
    });
    actions.appendChild(copy);
    node.appendChild(actions);
    el.messages.appendChild(node);
    syncWelcome();
    scrollToBottom();
    return node;
  }

  function appendNotice(text, level = "info") {
    const node = document.createElement("div");
    node.className = `notice ${level}`;
    node.innerHTML = `<span>${level === "error" ? "✘" : level === "warn" ? "▲" : level === "success" ? "✔" : "•"}</span><span>${escapeHtml(text)}</span>`;
    el.messages.appendChild(node);
    scrollToBottom();
  }

  function formatToolArgs(raw) {
    if (!raw) return "";
    if (typeof raw === "string") {
      try {
        return JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        return raw;
      }
    }
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  }

  function createToolCard(callId, name, permission, summary, args) {
    const node = document.createElement("div");
    node.className = "tool-card";
    node.dataset.callId = callId;
    const formatted = formatToolArgs(args);
    node.innerHTML = `
      <div class="tool-head">
        <span class="tool-dot"></span>
        <span class="tool-name">${escapeHtml(name)}</span>
        ${permission ? `<span class="tool-perm">${escapeHtml(permission)}</span>` : ""}
        <span class="tool-summary">${escapeHtml(summary || "")}</span>
        <span class="tool-time"></span>
      </div>
      ${formatted ? `<details class="tool-details"><summary>arguments</summary><pre class="tool-args">${escapeHtml(formatted)}</pre></details>` : ""}
      <pre class="tool-output hidden"></pre>`;
    el.messages.appendChild(node);
    syncWelcome();
    scrollToBottom();
    return node;
  }

  function extractDiff(result) {
    const data = result?.data;
    if (!data || typeof data !== "object") return "";
    for (const key of ["diff", "patch", "unifiedDiff"]) {
      const value = data[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return "";
  }

  function finishToolCard(callId, name, result) {
    let node = el.messages.querySelector(`.tool-card[data-call-id="${cssEscape(callId)}"]`);
    if (!node) node = createToolCard(callId, name, "", "");
    node.classList.toggle("ok", Boolean(result?.ok));
    node.classList.toggle("error", !result?.ok);
    const started = state.toolStartedAt.get(callId);
    if (started) {
      const elapsed = Date.now() - started;
      const time = node.querySelector(".tool-time");
      if (time) time.textContent = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
      state.toolStartedAt.delete(callId);
    }
    const out = node.querySelector(".tool-output");
    if (out && result?.output) {
      out.classList.remove("hidden");
      out.textContent = result.output;
    }
    const diff = extractDiff(result);
    if (diff && !node.querySelector(".diff-block")) {
      const block = document.createElement("pre");
      block.className = "diff-block";
      const lines = diff.split("\n").slice(0, 400);
      for (const line of lines) {
        const span = document.createElement("span");
        span.className = "diff-line";
        if (line.startsWith("+") && !line.startsWith("+++")) span.classList.add("add");
        else if (line.startsWith("-") && !line.startsWith("---")) span.classList.add("del");
        else if (line.startsWith("@@")) span.classList.add("hunk");
        span.textContent = line || " ";
        block.appendChild(span);
        block.appendChild(document.createTextNode("\n"));
      }
      node.appendChild(block);
    }
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function ensureStreamingNode() {
    let node = el.messages.querySelector(".msg-streaming");
    if (!node) {
      node = document.createElement("div");
      node.className = "msg msg-assistant msg-streaming";
      node.innerHTML = `
        <div class="msg-label"><span>TagCode</span><span class="time">${nowTime()}</span><span class="spinner"></span></div>
        <div class="thinking hidden"></div>
        <div class="markdown"></div>`;
      el.messages.appendChild(node);
      syncWelcome();
    }
    return node;
  }

  function updateStreaming() {
    if (!state.streaming && !state.reasoning) return;
    const node = ensureStreamingNode();
    const think = node.querySelector(".thinking");
    if (state.reasoning) {
      think.classList.remove("hidden");
      think.textContent = state.reasoning;
    }
    node.querySelector(".markdown").innerHTML = renderMarkdown(state.streaming || " ");
    scrollToBottom();
  }

  function clearStreaming() {
    el.messages.querySelector(".msg-streaming")?.remove();
    state.streaming = "";
    state.reasoning = "";
  }

  function renderPlan(steps) {
    state.plan = steps;
    let node = el.messages.querySelector(".plan-card");
    if (!steps || steps.length === 0) {
      node?.remove();
      return;
    }
    if (!node) {
      node = document.createElement("div");
      node.className = "plan-card";
      el.messages.appendChild(node);
    }
    node.innerHTML = `<h3>Plan</h3>${steps
      .map((step) => {
        const icon =
          step.status === "completed"
            ? "✔"
            : step.status === "in_progress"
              ? "▶"
              : step.status === "blocked"
                ? "!"
                : "○";
        return `<div class="plan-step ${escapeHtml(step.status)}"><span>${icon}</span><span>${escapeHtml(step.title)}</span></div>`;
      })
      .join("")}`;
    scrollToBottom();
  }

  function renderMessages(messages, plan) {
    el.messages.innerHTML = "";
    state.plan = null;
    clearStreaming();
    for (const message of messages || []) {
      if (message.role === "user") {
        appendUser(message.content);
      } else if (message.role === "assistant") {
        if (message.content || message.reasoning) appendAssistant(message.content, message.reasoning);
      } else if (message.role === "tool") {
        const card = createToolCard(message.toolCallId, message.name || "tool", "", "");
        card.classList.add(message.isError ? "error" : "ok");
        const out = card.querySelector(".tool-output");
        out.classList.remove("hidden");
        out.textContent = message.content || "";
      }
    }
    if (plan?.length) renderPlan(plan);
    syncWelcome();
    scrollToBottom(true);
  }

  function renderChrome() {
    const data = state.data;
    if (!data) return;
    const hasProvider = Boolean(data.provider);
    const hasModel = Boolean(data.model);
    const modelText = hasProvider && hasModel ? `${data.provider}/${data.model}` : "not configured";

    el.workspace.textContent = data.workspace || "—";
    el.workspace.title = data.workspace || "";
    el.modelPill.textContent = modelText;
    el.connectBtn.textContent = hasProvider ? "Add provider" : "Connect model";
    el.connectBtn.classList.toggle("primary", !hasProvider);
    el.setupBanner.classList.toggle("hidden", hasProvider && hasModel);
    const setupTitle = el.setupBanner.querySelector("strong");
    const setupText = el.setupBanner.querySelector(".setup-copy span");
    const setupButton = el.setupBanner.querySelector("[data-connect]");
    if (!hasProvider) {
      setupTitle.textContent = "Connect a model provider";
      setupText.textContent = "TagCode needs a model before it can inspect files or run tools.";
      setupButton.textContent = "Choose a provider";
    } else {
      setupTitle.textContent = "Choose a model";
      setupText.textContent = "The provider is connected. Pick the model TagCode should use.";
      setupButton.textContent = "Select model";
    }

    el.modeBadge.textContent = String(data.mode || "agent").toUpperCase();
    el.modeBadge.className = `mode-badge ${data.mode || "agent"}`;
    el.permissionLabel.textContent = data.permission || "auto";
    el.composerModel.textContent = modelText;

    el.infoWorkspace.textContent = data.workspace || "—";
    el.infoWorkspace.title = data.workspace || "";
    el.infoModel.textContent = hasProvider ? modelText : "not configured";
    el.infoModel.classList.toggle("accent", !hasProvider || !hasModel);
    el.infoMode.textContent = String(data.mode || "agent").toUpperCase();
    el.infoPermission.textContent = data.permission || "auto";
    el.infoSession.textContent = (data.sessionId || "").slice(-8) || "—";
    el.infoBranch.textContent = data.gitBranch || "—";

    const usage = data.usage || { inputTokens: 0, outputTokens: 0 };
    const tokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
    el.infoTokens.textContent = tokens.toLocaleString();
    const percent = data.context
      ? Math.round((data.context.estimatedTokens / Math.max(1, data.context.budget)) * 100)
      : 0;
    el.infoContext.textContent = data.context ? `${percent}%` : "—";
    el.contextFill.style.width = `${Math.min(100, percent)}%`;
    el.contextFill.classList.toggle("high", percent > 85);

    const mcp = data.mcp || [];
    const connected = mcp.filter((entry) => entry.state === "connected").length;
    el.infoMcp.textContent = mcp.length ? `${connected}/${mcp.length}` : "—";
    el.infoSkills.textContent = String((data.skills || []).length);
    el.mcpTabCount.textContent = String(connected);
    el.skillsTabCount.textContent = String((data.skills || []).length);
    renderMcp(mcp);
    renderSkills(data.skills || []);
    if (!state.running && Date.now() >= state.mascotLockedUntil) {
      setMascot(data.mode === "plan" ? "plan" : "idle");
    }

    const parts = [
      modelText,
      data.gitBranch ? `⑂ ${data.gitBranch}` : null,
      mcp.length ? `mcp ${connected}/${mcp.length}` : null,
      data.context ? `ctx ${percent}%` : null,
      tokens ? `${tokens.toLocaleString()} tok` : null,
      sessionDuration(data),
    ].filter(Boolean);
    el.statusline.textContent = parts.join("  ·  ");
    document.title = `${data.workspace ? baseName(data.workspace) + " · " : ""}TagCode`;
  }

  function renderMcp(servers) {
    const signature = JSON.stringify(
      servers.map((server) => [server.name, server.state, server.toolCount, server.error]),
    );
    if (signature === state.lastMcpSignature) return;
    state.lastMcpSignature = signature;
    const connected = servers.filter((server) => server.state === "connected").length;
    el.mcpSummary.textContent = servers.length
      ? `${connected} of ${servers.length} connected · tools appear as mcp:<server>:<tool>`
      : "No MCP servers configured. Add one to extend the agent with external tools.";
    el.mcpList.innerHTML = "";
    if (servers.length === 0) {
      el.mcpList.innerHTML = '<div class="mcp-empty">Add a filesystem, GitHub, database or browser server from the + button.</div>';
      return;
    }
    for (const server of servers) {
      const item = document.createElement("div");
      item.className = "mcp-item";
      const tools = (server.tools || []).slice(0, 10);
      item.innerHTML = `
        <div class="mcp-top">
          <span class="mcp-dot ${escapeHtml(server.state)}"></span>
          <span class="mcp-name" title="${escapeHtml(server.name)}">${escapeHtml(server.name)}</span>
          <span class="mcp-transport">${escapeHtml(server.transport || "stdio")}</span>
        </div>
        <div class="mcp-meta">${escapeHtml(server.state)} · ${server.toolCount || 0} tools · ${server.resourceCount || 0} resources · ${server.promptCount || 0} prompts</div>
        ${server.error ? `<div class="mcp-error">${escapeHtml(server.error)}</div>` : ""}
        ${tools.length ? `<div class="mcp-tools">${tools.map((tool) => `<span class="mcp-tool" title="${escapeHtml(tool)}">${escapeHtml(tool.replace(/^mcp:[^:]+:/, ""))}</span>`).join("")}</div>` : ""}
        <div class="mcp-actions">
          <button class="ghost" data-mcp-action="${server.state === "connected" ? "disconnect" : "connect"}" data-mcp-name="${escapeHtml(server.name)}">${server.state === "connected" ? "Disconnect" : "Connect"}</button>
          <button class="ghost" data-mcp-action="reconnect" data-mcp-name="${escapeHtml(server.name)}">Reconnect</button>
          <button class="ghost" data-mcp-action="remove" data-mcp-name="${escapeHtml(server.name)}">Remove</button>
        </div>`;
      el.mcpList.appendChild(item);
    }
  }

  function renderSkills(skills, force = false) {
    const signature = JSON.stringify(
      skills.map((skill) => [skill.name, skill.valid, skill.source, skill.description]),
    );
    if (signature === state.lastSkillsSignature && !force) return;
    state.lastSkillsSignature = signature;
    const query = el.skillSearch.value.trim().toLowerCase();
    const filtered = skills.filter(
      (skill) =>
        !query ||
        skill.name.toLowerCase().includes(query) ||
        (skill.description || "").toLowerCase().includes(query) ||
        (skill.tags || []).some((tag) => tag.toLowerCase().includes(query)),
    );
    el.skillList.innerHTML = "";
    if (skills.length === 0) {
      el.skillList.innerHTML = '<div class="skill-empty">No skills installed. Add a Git skill or generate one from a description.</div>';
      return;
    }
    if (filtered.length === 0) {
      el.skillList.innerHTML = '<div class="skill-empty">No skills match this search.</div>';
      return;
    }
    for (const skill of filtered) {
      const item = document.createElement("div");
      item.className = "skill-item";
      const tags = [...(skill.tags || []), ...(skill.allowedTools || []).map((tool) => `tool:${tool}`)].slice(0, 6);
      item.innerHTML = `
        <div class="skill-top">
          <span class="skill-dot ${skill.valid ? "valid" : "invalid"}"></span>
          <span class="skill-name" title="${escapeHtml(skill.name)}">${escapeHtml(skill.name)}</span>
          <span class="skill-source">${escapeHtml(skill.source || "project")}</span>
        </div>
        <div class="skill-desc">${escapeHtml(skill.description || "No description")}</div>
        ${tags.length ? `<div class="skill-tags">${tags.map((tag) => `<span class="skill-tag">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
        <div class="skill-actions">
          <button class="ghost" data-skill-view="${escapeHtml(skill.name)}">View</button>
          <button class="ghost" data-skill-remove="${escapeHtml(skill.name)}" data-skill-source="${escapeHtml(skill.source)}">Remove</button>
        </div>`;
      el.skillList.appendChild(item);
    }
  }

  const MCP_CATEGORY_LABELS = {
    files: "files",
    git: "git",
    data: "data",
    browser: "browser",
    web: "web",
    productivity: "workflow",
  };

  function replaceTemplateValues(value, inputs) {
    return String(value ?? "").replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (_match, key) => {
      if (key === "workspace") return state.data?.workspace || "workspace";
      return inputs[key] || `{${key}}`;
    });
  }

  function mcpTemplatePreview(template, inputs = {}) {
    if (template.transport === "http") return replaceTemplateValues(template.url || "", inputs);
    const parts = [template.command || "", ...(template.args || [])]
      .map((part) => replaceTemplateValues(part, inputs))
      .filter(Boolean);
    for (const key of Object.keys(template.env || {})) {
      parts.push(`${key}=${inputs[key] ? "••••" : `{${key}}`}`);
    }
    return parts.join(" ");
  }

  function mcpCatalogCard(template) {
    const command = mcpTemplatePreview(template);
    return `<button class="catalog-card" data-mcp-template="${escapeHtml(template.id)}">
      <span class="catalog-card-top">
        <span class="catalog-card-title">${escapeHtml(template.title)}</span>
        ${template.installed ? '<span class="catalog-installed">installed</span>' : `<span class="catalog-category">${escapeHtml(MCP_CATEGORY_LABELS[template.category] || template.category)}</span>`}
      </span>
      <span class="catalog-desc">${escapeHtml(template.description)}</span>
      <span class="catalog-path" title="${escapeHtml(command)}">${escapeHtml(command)}</span>
      <span class="catalog-tags">
        <span class="catalog-tag">${escapeHtml(template.transport)}</span>
        <span class="catalog-tag">${escapeHtml(template.permission)}</span>
        ${(template.requires || []).slice(0, 2).map((item) => `<span class="catalog-tag">${escapeHtml(item)}</span>`).join("")}
      </span>
    </button>`;
  }

  async function mcpCatalogModal() {
    let data;
    try {
      data = await api("/api/mcp/catalog");
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    const { root } = showModal(
      `<div class="modal-head">
        <div><h2>MCP catalog</h2><p>Ready-made servers with a preview. Pick one, fill the required fields and TagCode writes the configuration for you.</p></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <input class="search compact" id="mcp-catalog-search" placeholder="Search MCP servers…" spellcheck="false" autocomplete="off" />
      <div class="catalog-grid" id="mcp-catalog-grid"></div>
      <p class="catalog-note">Tools from every server still pass through the shared permission gate. Secrets are stored in the MCP configuration file; prefer a scoped token.</p>`,
      { wide: true },
    );
    const search = root.querySelector("#mcp-catalog-search");
    const grid = root.querySelector("#mcp-catalog-grid");
    const render = () => {
      const query = search.value.trim().toLowerCase();
      const templates = (data.templates || []).filter((template) => {
        if (!query) return true;
        const haystack = `${template.title} ${template.description} ${(template.requires || []).join(" ")} ${template.category}`.toLowerCase();
        return haystack.includes(query);
      });
      grid.innerHTML = templates.length
        ? templates.map(mcpCatalogCard).join("")
        : '<div class="catalog-empty">No MCP servers match this search.</div>';
    };
    search.addEventListener("input", render);
    grid.addEventListener("click", (event) => {
      const card = event.target.closest("[data-mcp-template]");
      if (!card) return;
      const template = data.templates.find((entry) => entry.id === card.dataset.mcpTemplate);
      if (template) mcpTemplateModal(template, data.workspace);
    });
    render();
    search.focus();
  }

  function mcpTemplateModal(template, workspace) {
    const fields = template.inputs || [];
    const { root } = showModal(
      `<div class="modal-head">
        <div><h2>${escapeHtml(template.title)}</h2><p>${escapeHtml(template.description)}</p></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="catalog-detail-head">
        <div class="catalog-icon">⌁</div>
        <div>
          <h3 class="catalog-detail-title">${escapeHtml(template.transport)} server</h3>
          <p class="catalog-detail-copy">${escapeHtml((template.requires || []).join(" · ") || "No extra runtime required.")}</p>
        </div>
      </div>
      <div class="catalog-section-title">Command preview</div>
      <div class="catalog-command" id="mcp-preview">${escapeHtml(mcpTemplatePreview(template))}</div>
      ${fields
        .map(
          (field) => `<div class="field">
            <label for="mcp-field-${escapeHtml(field.key)}">${escapeHtml(field.label)}${field.required ? " *" : ""}</label>
            <input id="mcp-field-${escapeHtml(field.key)}" data-input-key="${escapeHtml(field.key)}" type="${field.secret ? "password" : "text"}" spellcheck="false" autocomplete="off" placeholder="${escapeHtml((field.placeholder || "").replace("{{workspace}}", workspace || state.data?.workspace || ""))}" value="${escapeHtml((field.default || "").replace("{{workspace}}", workspace || state.data?.workspace || ""))}" />
            ${field.help ? `<small>${escapeHtml(field.help)}</small>` : ""}
          </div>`,
        )
        .join("")}
      <div class="field"><label for="mcp-catalog-scope">Configuration scope</label><select id="mcp-catalog-scope"><option value="global">Global (~/.tagcode)</option><option value="project">Project (.tagcode)</option></select></div>
      ${template.notes ? `<div class="notice">${escapeHtml(template.notes)}</div>` : ""}
      ${template.docsUrl ? `<p class="catalog-note">Docs: <a href="${escapeHtml(template.docsUrl)}" target="_blank" rel="noreferrer">${escapeHtml(template.docsUrl)}</a></p>` : ""}
      <div class="form-error hidden" id="mcp-catalog-error"></div>
      <div class="modal-actions">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" id="mcp-catalog-submit">${template.installed ? "Reinstall" : "Add server"}</button>
      </div>`,
      { wide: true },
    );
    const preview = root.querySelector("#mcp-preview");
    const error = root.querySelector("#mcp-catalog-error");
    const collect = () => {
      const inputs = {};
      for (const input of root.querySelectorAll("[data-input-key]")) {
        if (input.value.trim()) inputs[input.dataset.inputKey] = input.value.trim();
      }
      return inputs;
    };
    const syncPreview = () => {
      preview.textContent = mcpTemplatePreview(template, collect());
    };
    root.querySelectorAll("[data-input-key]").forEach((input) => input.addEventListener("input", syncPreview));
    root.querySelector("#mcp-catalog-submit").addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      error.classList.add("hidden");
      try {
        await api("/api/mcp/install", {
          method: "POST",
          body: {
            template: template.id,
            inputs: collect(),
            scope: root.querySelector("#mcp-catalog-scope").value,
            replace: Boolean(template.installed),
          },
        });
        close();
        await refreshState();
        toast(`${template.title} MCP server added.`, "success");
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove("hidden");
      } finally {
        event.currentTarget.disabled = false;
      }
    });
    const first = root.querySelector("[data-input-key]");
    if (first) first.focus();
  }

  function skillCatalogCard(entry) {
    return `<button class="catalog-card" data-skill-catalog="${escapeHtml(entry.id)}">
      <span class="catalog-card-top">
        <span class="catalog-card-title">${escapeHtml(entry.name)}</span>
        ${entry.installed ? '<span class="catalog-installed">installed</span>' : `<span class="catalog-category">${escapeHtml(entry.version ? `v${entry.version}` : "skill")}</span>`}
      </span>
      <span class="catalog-desc">${escapeHtml(entry.description)}</span>
      <span class="catalog-tags">${(entry.tags || []).slice(0, 4).map((tag) => `<span class="catalog-tag">${escapeHtml(tag)}</span>`).join("")}</span>
    </button>`;
  }

  async function skillCatalogModal() {
    let data;
    try {
      data = await api("/api/skills/catalog");
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    const { root } = showModal(
      `<div class="modal-head">
        <div><h2>Skill catalog</h2><p>Curated Agent Skills with a full preview. Install one into this project or globally; every skill is a plain SKILL.md file you can edit.</p></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <input class="search compact" id="skill-catalog-search" placeholder="Search skills…" spellcheck="false" autocomplete="off" />
      <div class="catalog-grid" id="skill-catalog-grid"></div>
      <p class="catalog-note">Installed skills are selected automatically for matching tasks. You can remove or reload them from the Skills panel.</p>`,
      { wide: true },
    );
    const search = root.querySelector("#skill-catalog-search");
    const grid = root.querySelector("#skill-catalog-grid");
    const render = () => {
      const query = search.value.trim().toLowerCase();
      const entries = (data.skills || []).filter((entry) => {
        if (!query) return true;
        const haystack = `${entry.name} ${entry.description} ${(entry.tags || []).join(" ")}`.toLowerCase();
        return haystack.includes(query);
      });
      grid.innerHTML = entries.length
        ? entries.map(skillCatalogCard).join("")
        : '<div class="catalog-empty">No skills match this search.</div>';
    };
    search.addEventListener("input", render);
    grid.addEventListener("click", (event) => {
      const card = event.target.closest("[data-skill-catalog]");
      if (!card) return;
      const entry = data.skills.find((item) => item.id === card.dataset.skillCatalog);
      if (entry) skillCatalogPreview(entry);
    });
    render();
    search.focus();
  }

  function skillCatalogPreview(entry) {
    const body = String(entry.instructions || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    const { root } = showModal(
      `<div class="modal-head">
        <div><h2>${escapeHtml(entry.name)}</h2><p>${escapeHtml(entry.description)}</p></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="chips" style="margin-top:0">
        ${entry.installed ? '<span class="chip selected">installed</span>' : '<span class="chip">not installed</span>'}
        ${entry.version ? `<span class="chip">v${escapeHtml(entry.version)}</span>` : ""}
        ${entry.author ? `<span class="chip">${escapeHtml(entry.author)}</span>` : ""}
        ${(entry.tags || []).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join("")}
      </div>
      <div class="catalog-scroll markdown">${renderMarkdown(body)}</div>
      <div class="field" style="margin-top:14px"><label for="skill-catalog-scope">Install scope</label><select id="skill-catalog-scope"><option value="project">Project (.tagcode/skills)</option><option value="global">Global (~/.tagcode/skills)</option></select></div>
      ${entry.installed ? '<div class="notice warn">Reinstalling replaces the local copy with the catalog version.</div>' : ""}
      <div class="form-error hidden" id="skill-catalog-error"></div>
      <div class="modal-actions">
        <button class="btn" data-close>Close</button>
        <button class="btn primary" id="skill-catalog-submit">${entry.installed ? "Reinstall" : "Install skill"}</button>
      </div>`,
      { wide: true },
    );
    const error = root.querySelector("#skill-catalog-error");
    root.querySelector("#skill-catalog-submit").addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      error.classList.add("hidden");
      try {
        await api("/api/skills/action", {
          method: "POST",
          body: {
            action: "install-catalog",
            catalog: entry.id,
            scope: root.querySelector("#skill-catalog-scope").value,
            force: Boolean(entry.installed),
          },
        });
        el.modalRoot.innerHTML = "";
        await refreshState();
        toast(`${entry.name} installed.`, "success");
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove("hidden");
      } finally {
        event.currentTarget.disabled = false;
      }
    });
  }

  function renderUpdate() {
    const info = state.update;
    if (info?.updateAvailable && info.latestVersion) {
      el.updatePill.textContent = `↑ v${info.latestVersion}`;
      el.updatePill.title = `TagCode ${info.latestVersion} is available (current ${info.currentVersion})`;
      el.updatePill.classList.remove("hidden");
    } else {
      el.updatePill.classList.add("hidden");
    }
  }

  async function checkForUpdates(manual = false) {
    try {
      const info = await api(`/api/update${manual ? "?refresh=1" : ""}`);
      state.update = info;
      renderUpdate();
      if (manual) {
        if (info.error) toast(`Update check failed: ${info.error}`, "error");
        else if (info.updateAvailable) {
          toast(`TagCode ${info.latestVersion} is available.`, "success");
          updateModal();
        } else toast("TagCode is up to date.", "success");
      }
    } catch (error) {
      if (manual) toast(error.message, "error");
    }
  }

  function updateModal() {
    const info = state.update;
    if (!info) {
      void checkForUpdates(true);
      return;
    }
    const { root } = showModal(
      `<div class="modal-head">
        <div><h2>${info.updateAvailable ? "Update available" : "TagCode is up to date"}</h2><p>Current version v${escapeHtml(info.currentVersion)}${info.latestVersion ? ` · latest v${escapeHtml(info.latestVersion)}` : ""}${info.error ? " · registry check failed" : ""}</p></div>
        <button class="modal-close" data-close>×</button>
      </div>
      ${info.error ? `<div class="notice error">${escapeHtml(info.error)}</div>` : ""}
      ${info.updateAvailable ? `<div class="catalog-section-title" style="margin-top:14px">Upgrade command</div><div class="catalog-command">${escapeHtml(info.installCommand)}</div><p class="catalog-note">Run this in a terminal, then restart TagCode. Your sessions, MCP servers and skills are kept.</p>` : '<div class="notice success">No newer release was found on npm.</div>'}
      <p class="catalog-note"><a href="${escapeHtml(info.packageUrl)}" target="_blank" rel="noreferrer">${escapeHtml(info.packageUrl)}</a></p>
      <div class="modal-actions">
        <button class="btn" id="update-copy">${info.updateAvailable ? "Copy command" : "Copy version info"}</button>
        <button class="btn" id="update-recheck">Check again</button>
        <button class="btn primary" data-close>Close</button>
      </div>`,
    );
    root.querySelector("#update-copy").addEventListener("click", async () => {
      const value = info.updateAvailable ? info.installCommand : `tagcode ${info.currentVersion}`;
      await copyText(value);
      toast("Copied to clipboard.", "success");
    });
    root.querySelector("#update-recheck").addEventListener("click", async () => {
      await checkForUpdates(true);
      if (state.update?.updateAvailable) {
        el.modalRoot.innerHTML = "";
        updateModal();
      }
    });
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
  }

  function baseName(value) {
    return String(value).split(/[\\/]/).filter(Boolean).pop() || value;
  }

  function sessionDuration(data) {
    if (!data.createdAt) return null;
    const ms = Date.now() - Date.parse(data.createdAt);
    if (!Number.isFinite(ms) || ms < 0) return null;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }

  async function refreshState(options = {}) {
    try {
      state.data = await api("/api/state");
      renderChrome();
      if (options.messages) renderMessages(state.data.messages, state.data.plan?.steps);
      else syncWelcome();
      if (el.input.value.startsWith("/")) updateCommandMenu();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function showModal(html, options = {}) {
    el.modalRoot.innerHTML = `<div class="modal-card ${options.wide ? "wide" : ""}">${html}</div>`;
    const close = () => {
      el.modalRoot.innerHTML = "";
    };
    el.modalRoot.querySelectorAll("[data-close]").forEach((button) => {
      button.addEventListener("click", close);
    });
    return { close, root: el.modalRoot.querySelector(".modal-card") };
  }

  function connectModal() {
    const options = Object.entries(PROVIDERS)
      .map(([value, preset]) => `<option value="${value}">${escapeHtml(preset.label)}</option>`)
      .join("");
    const { close, root } = showModal(
      `<div class="modal-head">
        <div><h2>Connect a model provider</h2><p>Choose a hosted API or a local OpenAI-compatible server.</p></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="field"><label for="provider-type">Provider</label><select id="provider-type">${options}</select></div>
      <div class="field"><label for="provider-base">Base URL</label><input id="provider-base" spellcheck="false" /><small>OpenAI-compatible endpoint. Keep the /v1 suffix where required.</small></div>
      <div class="field"><label for="provider-model">Default model <span style="color:var(--faint)">(optional)</span></label><input id="provider-model" spellcheck="false" /><small>Leave empty and TagCode will fetch the provider model list.</small></div>
      <div class="field" id="provider-key-field"><label for="provider-key">API key</label><input id="provider-key" type="password" spellcheck="false" /><small>Stored in the OS credential store when available; otherwise a mode-0600 file.</small></div>
      <div class="field"><label for="provider-scope">Configuration scope</label><select id="provider-scope"><option value="global">Global (~/.tagcode)</option><option value="project">Project (.tagcode)</option></select></div>
      <div class="form-error hidden" id="provider-error"></div>
      <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="provider-submit">Connect</button></div>`,
    );

    const type = root.querySelector("#provider-type");
    const base = root.querySelector("#provider-base");
    const model = root.querySelector("#provider-model");
    const key = root.querySelector("#provider-key");
    const keyField = root.querySelector("#provider-key-field");
    const error = root.querySelector("#provider-error");

    const applyPreset = () => {
      const preset = PROVIDERS[type.value];
      base.value = preset.baseUrl;
      model.value = preset.model;
      key.value = "";
      keyField.classList.toggle("hidden", !preset.key);
    };
    applyPreset();
    type.addEventListener("change", applyPreset);
    base.addEventListener("input", () => error.classList.add("hidden"));

    root.querySelector("#provider-submit").addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      error.classList.add("hidden");
      try {
        await api("/api/provider", {
          method: "POST",
          body: {
            type: type.value,
            baseUrl: base.value.trim() || undefined,
            model: model.value.trim() || undefined,
            apiKey: key.value.trim() || undefined,
            scope: root.querySelector("#provider-scope").value,
          },
        });
        close();
        await refreshState();
        toast("Provider connected.", "success");
        await modelModal();
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove("hidden");
      } finally {
        event.currentTarget.disabled = false;
      }
    });
  }

  async function modelModal() {
    let data;
    el.modelPill.textContent = "fetching models…";
    try {
      data = await api("/api/models");
    } catch (error) {
      toast(error.message, "error");
      if (state.data) renderChrome();
      if (!state.data?.provider) connectModal();
      return;
    }
    if (state.data) renderChrome();
    const models = data.models || [];
    if (!models.length) {
      toast(data.error || "No models available. Connect a provider first.", "error");
      if (!state.data?.provider) connectModal();
      return;
    }
    const current = state.data?.model || "";
    const { root } = showModal(
      `<div class="modal-head">
        <div><h2>Select a model</h2><p>${data.error ? `Using configured models (${escapeHtml(data.error)}).` : "Fetched live from the active provider."}</p></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <input class="search" id="model-search" placeholder="Search models…" spellcheck="false" />
      <div class="model-list" id="model-list"></div>`,
    );
    const list = root.querySelector("#model-list");
    const search = root.querySelector("#model-search");
    const render = () => {
      const query = search.value.trim().toLowerCase();
      list.innerHTML = "";
      for (const model of models.filter((entry) => !query || entry.toLowerCase().includes(query))) {
        const button = document.createElement("button");
        button.className = `model-item${model === current ? " current" : ""}`;
        button.innerHTML = `<span>${escapeHtml(model)}</span>${model === current ? '<span class="check">✓ current</span>' : ""}`;
        button.addEventListener("click", async () => {
          try {
            await api("/api/model", { method: "POST", body: { model } });
            el.modalRoot.innerHTML = "";
            await refreshState();
            toast(`Model set to ${model} and saved for next launch.`, "success");
            el.input.focus();
          } catch (error) {
            toast(error.message, "error");
          }
        });
        list.appendChild(button);
      }
      if (!list.children.length) list.innerHTML = '<div class="notice">No matching models.</div>';
    };
    search.addEventListener("input", render);
    render();
    setTimeout(() => search.focus(), 30);
  }

  function settingsModal() {
    const data = state.data || {};
    const modes = ["agent", "plan", "ask"]
      .map((mode) => `<option value="${mode}"${data.mode === mode ? " selected" : ""}>${mode}</option>`)
      .join("");
    const permissions = ["ask", "auto", "plan", "yolo"]
      .map(
        (mode) =>
          `<option value="${mode}"${data.permission === mode ? " selected" : ""}>${mode}</option>`,
      )
      .join("");
    const providers = (data.providers || [])
      .map(
        (provider) =>
          `<div class="info-row"><span>${escapeHtml(provider.id)} · ${escapeHtml(provider.type)}</span><button class="ghost" style="flex:0" data-remove-provider="${escapeHtml(provider.id)}">Remove</button></div>`,
      )
      .join("");
    const { close, root } = showModal(
      `<div class="modal-head">
        <div><h2>Settings</h2><p>Modes, permissions and provider configuration.</p></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="field"><label for="settings-mode">Interaction mode</label><select id="settings-mode">${modes}</select><small>Plan and ask are read-only.</small></div>
      <div class="field"><label for="settings-permission">Permission mode</label><select id="settings-permission">${permissions}</select><small>YOLO disables approval prompts. Use with care.</small></div>
      <div class="panel-title" style="margin-top:18px">Configured providers</div>
      <div id="settings-providers">${providers || '<div class="notice">No providers configured.</div>'}</div>
      <div class="modal-actions">
        <button class="btn" id="settings-update">Check updates</button>
        <button class="btn" id="settings-connect">Add provider</button>
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" id="settings-save">Save</button>
      </div>`,
    );
    root.querySelector("#settings-update").addEventListener("click", async () => {
      await checkForUpdates(true);
      if (state.update?.updateAvailable) {
        close();
        updateModal();
      }
    });
    root.querySelector("#settings-connect").addEventListener("click", () => connectModal());
    root.querySelectorAll("[data-remove-provider]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (!confirm(`Remove provider ${button.dataset.removeProvider}?`)) return;
        try {
          await api("/api/provider/remove", {
            method: "POST",
            body: { id: button.dataset.removeProvider },
          });
          close();
          await refreshState();
          toast("Provider removed.", "success");
        } catch (error) {
          toast(error.message, "error");
        }
      });
    });
    root.querySelector("#settings-save").addEventListener("click", async () => {
      try {
        await api("/api/mode", {
          method: "POST",
          body: { mode: root.querySelector("#settings-mode").value },
        });
        await api("/api/permission", {
          method: "POST",
          body: { mode: root.querySelector("#settings-permission").value },
        });
        close();
        await refreshState();
        toast("Settings saved.", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    });
  }

  function mcpModal() {
    const templates = {
      filesystem: {
        transport: "stdio",
        command: "npx",
        args: "-y @modelcontextprotocol/server-filesystem .",
        name: "filesystem",
      },
      github: {
        transport: "stdio",
        command: "npx",
        args: "-y @modelcontextprotocol/server-github",
        name: "github",
      },
      postgres: {
        transport: "stdio",
        command: "npx",
        args: "-y @modelcontextprotocol/server-postgres postgresql://localhost/postgres",
        name: "postgres",
      },
      playwright: {
        transport: "stdio",
        command: "npx",
        args: "-y @playwright/mcp@latest",
        name: "playwright",
      },
      sequential: {
        transport: "stdio",
        command: "npx",
        args: "-y @modelcontextprotocol/server-sequential-thinking",
        name: "sequential-thinking",
      },
      remote: { transport: "http", command: "", args: "", name: "remote", url: "https://example.com/mcp" },
    };
    const { close, root } = showModal(
      `<div class="modal-head">
        <div><h2>Add MCP server</h2><p>Connect a local stdio process or a remote Streamable HTTP endpoint. MCP tools go through the same permission gate.</p></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="field"><label for="mcp-template">Template</label><select id="mcp-template">${Object.keys(templates)
        .map((key) => `<option value="${key}">${key}</option>`)
        .join("")}<option value="custom">custom</option></select></div>
      <div class="field"><label for="mcp-name">Server name</label><input id="mcp-name" spellcheck="false" /></div>
      <div class="field"><label for="mcp-transport">Transport</label><select id="mcp-transport"><option value="stdio">stdio (local process)</option><option value="http">HTTP (remote)</option></select></div>
      <div class="field" id="mcp-command-field"><label for="mcp-command">Command</label><input id="mcp-command" spellcheck="false" /><small>For example npx, node, uvx or an absolute executable path.</small></div>
      <div class="field" id="mcp-args-field"><label for="mcp-args">Arguments</label><input id="mcp-args" spellcheck="false" /></div>
      <div class="field hidden" id="mcp-url-field"><label for="mcp-url">URL</label><input id="mcp-url" spellcheck="false" /><small>Streamable HTTP endpoint.</small></div>
      <div class="field"><label for="mcp-permission">Tool permission</label><select id="mcp-permission"><option value="read">read</option><option value="write">write</option><option value="execute">execute</option><option value="network">network</option><option value="sensitive">sensitive</option></select></div>
      <div class="field"><label for="mcp-scope">Configuration scope</label><select id="mcp-scope"><option value="global">Global (~/.tagcode)</option><option value="project">Project (.tagcode)</option></select></div>
      <div class="form-error hidden" id="mcp-error"></div>
      <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="mcp-submit">Add server</button></div>`,
      { wide: true },
    );
    const template = root.querySelector("#mcp-template");
    const name = root.querySelector("#mcp-name");
    const transport = root.querySelector("#mcp-transport");
    const command = root.querySelector("#mcp-command");
    const args = root.querySelector("#mcp-args");
    const url = root.querySelector("#mcp-url");
    const error = root.querySelector("#mcp-error");
    const syncTransport = () => {
      const http = transport.value === "http";
      root.querySelector("#mcp-command-field").classList.toggle("hidden", http);
      root.querySelector("#mcp-args-field").classList.toggle("hidden", http);
      root.querySelector("#mcp-url-field").classList.toggle("hidden", !http);
    };
    const applyTemplate = () => {
      const preset = templates[template.value];
      if (!preset) {
        transport.value = "stdio";
        command.value = "";
        args.value = "";
        url.value = "";
        name.value = "";
      } else {
        transport.value = preset.transport;
        command.value = preset.command;
        args.value = preset.args;
        url.value = preset.url || "";
        name.value = preset.name;
      }
      syncTransport();
    };
    applyTemplate();
    template.addEventListener("change", applyTemplate);
    transport.addEventListener("change", syncTransport);
    root.querySelector("#mcp-submit").addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      error.classList.add("hidden");
      try {
        const parsedArgs = (args.value.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((entry) =>
          entry.replace(/^"|"$/g, ""),
        );
        await api("/api/mcp/add", {
          method: "POST",
          body: {
            name: name.value.trim(),
            transport: transport.value,
            command: command.value.trim() || undefined,
            args: parsedArgs,
            url: url.value.trim() || undefined,
            permission: root.querySelector("#mcp-permission").value,
            scope: root.querySelector("#mcp-scope").value,
          },
        });
        close();
        await refreshState();
        toast(`MCP server ${name.value.trim()} added.`, "success");
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove("hidden");
      } finally {
        event.currentTarget.disabled = false;
      }
    });
  }

  function skillModal() {
    const { close, root } = showModal(
      `<div class="modal-head">
        <div><h2>Add a skill</h2><p>Install an Agent Skill from Git or a local folder, or generate one from a description using the active model.</p></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="field"><label for="skill-mode">Source</label><select id="skill-mode"><option value="create">Generate from description</option><option value="git">Git repository</option><option value="local">Local folder</option></select></div>
      <div class="field" id="skill-source-field"><label for="skill-source" id="skill-source-label">Description</label><input id="skill-source" spellcheck="false" /><small id="skill-source-help">What should the skill teach TagCode? The active model writes SKILL.md.</small></div>
      <div class="field hidden" id="skill-create-source-field"><label for="skill-create-source">Context</label><select id="skill-create-source"><option value="all">Description + project + session</option><option value="description">Description only</option><option value="project">Project conventions</option><option value="session">Current session</option></select></div>
      <div class="field"><label for="skill-scope">Install scope</label><select id="skill-scope"><option value="project">Project (.tagcode/skills)</option><option value="global">Global (~/.tagcode/skills)</option></select></div>
      <div class="form-error hidden" id="skill-error"></div>
      <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="skill-submit">Add skill</button></div>`,
      { wide: true },
    );
    const mode = root.querySelector("#skill-mode");
    const source = root.querySelector("#skill-source");
    const label = root.querySelector("#skill-source-label");
    const help = root.querySelector("#skill-source-help");
    const createSource = root.querySelector("#skill-create-source-field");
    const error = root.querySelector("#skill-error");
    const syncMode = () => {
      createSource.classList.toggle("hidden", mode.value !== "create");
      if (mode.value === "create") {
        label.textContent = "Description";
        help.textContent = "What should the skill teach TagCode? The active model writes SKILL.md.";
        source.placeholder = "Review pull requests for security issues";
      } else if (mode.value === "git") {
        label.textContent = "Git URL";
        help.textContent = "A repository containing a SKILL.md at its root or in a subdirectory.";
        source.placeholder = "https://github.com/user/skill-repo";
      } else {
        label.textContent = "Local folder";
        help.textContent = "Absolute path to a folder containing SKILL.md.";
        source.placeholder = "C:\\project\\my-skill";
      }
      source.value = "";
    };
    mode.addEventListener("change", syncMode);
    syncMode();
    root.querySelector("#skill-submit").addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      error.classList.add("hidden");
      try {
        const value = source.value.trim();
        if (!value) throw new Error("Enter a source or description.");
        const scope = root.querySelector("#skill-scope").value;
        let result;
        if (mode.value === "create") {
          toast("Generating skill with the active model…");
          result = await api("/api/skills/action", {
            method: "POST",
            body: {
              action: "create",
              description: value,
              scope,
              source: root.querySelector("#skill-create-source").value,
            },
          });
          if (result.errors?.length) throw new Error(result.errors.join("\n"));
        } else {
          await api("/api/skills/action", {
            method: "POST",
            body: {
              action: "install",
              source: value,
              sourceType: mode.value,
              scope,
            },
          });
        }
        close();
        await refreshState();
        toast(mode.value === "create" ? "Skill generated and installed." : "Skill installed.", "success");
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove("hidden");
      } finally {
        event.currentTarget.disabled = false;
      }
    });
  }

  async function skillDetail(name) {
    let data;
    try {
      data = await api(`/api/skills/detail?name=${encodeURIComponent(name)}`);
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    const skill = data.skill;
    const meta = skill.metadata || {};
    showModal(
      `<div class="modal-head">
        <div><h2>${escapeHtml(skill.name)}</h2><p>${escapeHtml(skill.description || "")}</p></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="chips" style="margin-bottom:14px">
        <span class="chip">${escapeHtml(skill.source || "project")}</span>
        ${skill.valid ? '<span class="chip">valid</span>' : '<span class="chip">invalid</span>'}
        ${meta.version ? `<span class="chip">v${escapeHtml(meta.version)}</span>` : ""}
        ${meta.author ? `<span class="chip">${escapeHtml(meta.author)}</span>` : ""}
        ${skill.hasScripts ? '<span class="chip">scripts</span>' : ""}
        ${skill.hasReferences ? '<span class="chip">references</span>' : ""}
      </div>
      ${skill.errors?.length ? `<div class="notice error">${skill.errors.map(escapeHtml).join("<br>")}</div>` : ""}
      ${skill.warnings?.length ? `<div class="notice warn">${skill.warnings.map(escapeHtml).join("<br>")}</div>` : ""}
      <div class="markdown">${renderMarkdown(data.instructions || "")}</div>`,
      { wide: true },
    );
  }

  function approvalModal(id, request) {
    const risk = request.risk || "low";
    const { root } = showModal(
      `<div class="modal-head">
        <div><h2>${risk === "high" ? "Approval required" : "Permission request"}</h2>
        <p><strong>${escapeHtml(request.toolName)}</strong> · ${escapeHtml(request.permission)}${request.risk ? ` · risk: ${escapeHtml(request.risk)}` : ""}</p></div>
      </div>
      <p style="color:var(--muted);font-size:13px;line-height:1.55">${escapeHtml(request.summary)}</p>
      ${request.details ? `<div class="command-box">${escapeHtml(request.details)}</div>` : ""}
      ${request.command ? `<div class="command-box">$ ${escapeHtml(request.command)}</div>` : ""}
      <div class="modal-actions">
        <button class="btn danger" data-decision="deny">Deny</button>
        <button class="btn" data-decision="always">Always this session</button>
        <button class="btn primary" data-decision="allow">Approve</button>
      </div>`,
    );
    for (const button of root.querySelectorAll("[data-decision]")) {
      button.addEventListener("click", async () => {
        const decision = button.dataset.decision;
        try {
          await api("/api/approval", {
            method: "POST",
            body: { id, approved: decision !== "deny", remember: decision === "always" },
          });
          el.modalRoot.innerHTML = "";
        } catch (error) {
          toast(error.message, "error");
        }
      });
    }
  }

  function uiRequestModal(request) {
    if (request.kind === "confirm") {
      const { root } = showModal(
        `<div class="modal-head"><div><h2>Confirm</h2><p>${escapeHtml(request.message)}</p></div></div>
         <div class="modal-actions"><button class="btn" data-value="no">No</button><button class="btn primary" data-value="yes">Yes</button></div>`,
      );
      for (const button of root.querySelectorAll("[data-value]")) {
        button.addEventListener("click", async () => {
          await api("/api/respond", {
            method: "POST",
            body: { id: request.id, value: button.dataset.value === "yes" },
          });
          el.modalRoot.innerHTML = "";
        });
      }
      return;
    }

    if (request.kind === "secret") {
      const { root } = showModal(
        `<div class="modal-head"><div><h2>Secret required</h2><p>${escapeHtml(request.message)}</p></div></div>
         <div class="field"><input id="ui-secret" type="password" autocomplete="off" spellcheck="false" /></div>
         <div class="modal-actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" id="ui-submit">Submit</button></div>`,
      );
      const input = root.querySelector("#ui-secret");
      input.focus();
      const submit = async () => {
        await api("/api/respond", {
          method: "POST",
          body: { id: request.id, value: input.value },
        });
        el.modalRoot.innerHTML = "";
      };
      root.querySelector("#ui-submit").addEventListener("click", submit);
      root.querySelector("[data-cancel]").addEventListener("click", async () => {
        await api("/api/respond", { method: "POST", body: { id: request.id, cancelled: true } });
        el.modalRoot.innerHTML = "";
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit();
      });
      return;
    }

    const options = request.options || [];
    const { root } = showModal(
      `<div class="modal-head"><div><h2>Choose</h2><p>${escapeHtml(request.message)}</p></div></div>
       ${options.length ? `<div class="chips" id="ui-options">${options
         .map(
           (option, index) =>
             `<button class="chip" data-option="${escapeHtml(option)}">${
               /^\d+$/.test(option) ? option : escapeHtml(option)
             }</button>`,
         )
         .join("")}</div>` : ""}
       <div class="field" style="margin-top:12px"><input id="ui-input" placeholder="${options.length ? "Type a number or an exact value" : "Type your answer"}" spellcheck="false" /></div>
       <div class="modal-actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" id="ui-submit">Submit</button></div>`,
    );
    const input = root.querySelector("#ui-input");
    input.focus();
    const submit = async (value) => {
      await api("/api/respond", { method: "POST", body: { id: request.id, value } });
      el.modalRoot.innerHTML = "";
    };
    root.querySelector("#ui-submit").addEventListener("click", () => submit(input.value));
    root.querySelector("[data-cancel]").addEventListener("click", async () => {
      await api("/api/respond", { method: "POST", body: { id: request.id, cancelled: true } });
      el.modalRoot.innerHTML = "";
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit(input.value);
    });
    root.querySelectorAll("[data-option]").forEach((button) => {
      button.addEventListener("click", () => submit(button.dataset.option));
    });
  }

  function handleAgentEvent(event) {
    if (!event || !event.type) return;
    switch (event.type) {
      case "assistant-delta":
        state.streaming += event.text;
        if (state.activeTools.size === 0) setMascot("talking");
        updateStreaming();
        break;
      case "reasoning-delta":
        state.reasoning += event.text;
        setMascot("thinking");
        updateStreaming();
        break;
      case "assistant-message":
        clearStreaming();
        if (event.message?.content || event.message?.reasoning) {
          appendAssistant(event.message.content, event.message.reasoning);
        }
        break;
      case "tool-start":
        state.activeTools.set(event.call.id, event);
        state.toolStartedAt.set(event.call.id, Date.now());
        createToolCard(
          event.call.id,
          event.call.name,
          event.permission,
          event.summary,
          event.call.arguments,
        );
        setMascot("working");
        break;
      case "tool-end":
        state.activeTools.delete(event.callId);
        finishToolCard(event.callId, event.name, event.result);
        setMascot("thinking");
        break;
      case "tool-output":
        break;
      case "notice":
        appendNotice(event.text, event.level);
        break;
      case "plan":
        renderPlan(event.steps);
        break;
      case "usage":
        if (state.data) {
          state.data.usage = event.cumulative;
          renderChrome();
        }
        break;
      case "error":
        appendNotice(event.message, "error");
        toast(event.message, "error");
        setMascot("error", 2600);
        break;
      case "done":
        state.running = false;
        if (state.streaming || state.reasoning) {
          const text = state.streaming;
          const reasoning = state.reasoning;
          clearStreaming();
          appendAssistant(text, reasoning);
        } else {
          clearStreaming();
        }
        setMascot(event.reason === "error" ? "error" : "success", event.reason === "error" ? 2600 : 1900);
        syncWelcome();
        el.stopBtn.classList.add("hidden");
        el.sendBtn.classList.remove("hidden");
        el.input.focus();
        void refreshState();
        break;
      default:
        break;
    }
  }

  function connectEvents() {
    if (state.events) state.events.close();
    const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    state.events = source;
    source.onmessage = (message) => {
      let payload;
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }
      if (payload.type === "agent-event") handleAgentEvent(payload.event);
      else if (payload.type === "ui-request") uiRequestModal(payload.request);
      else if (payload.type === "connected") {
        void refreshState();
      }
    };
    source.onerror = () => {
      // EventSource reconnects automatically; keep the UI responsive.
    };
  }

  async function send() {
    const text = el.input.value.trim();
    if (!text || state.running) return;
    hideCommandMenu();
    el.input.value = "";
    resizeInput();
    if (text.startsWith("/")) {
      appendUser(text);
      try {
        const result = await api("/api/command", { method: "POST", body: { line: text } });
        if (result.resetView) {
          await refreshState({ messages: true });
        } else if (result.output) {
          appendNotice(result.output, "info");
        }
        if (result.exit) toast("Goodbye.", "success");
        await refreshState();
        setMascot("success", 1200);
      } catch (error) {
        appendNotice(error.message, "error");
        toast(error.message, "error");
        setMascot("error", 2200);
      }
      return;
    }

    appendUser(text);
    state.running = true;
    state.streaming = "";
    state.reasoning = "";
    el.sendBtn.classList.add("hidden");
    el.stopBtn.classList.remove("hidden");
    setMascot("thinking");
    syncWelcome();
    try {
      await api("/api/chat", { method: "POST", body: { text } });
    } catch (error) {
      state.running = false;
      el.sendBtn.classList.remove("hidden");
      el.stopBtn.classList.add("hidden");
      appendNotice(error.message, "error");
      toast(error.message, "error");
      setMascot("error", 2400);
    }
  }

  function resizeInput() {
    el.input.style.height = "auto";
    el.input.style.height = `${Math.min(220, el.input.scrollHeight)}px`;
  }

  function hideCommandMenu() {
    el.commandMenu.classList.add("hidden");
    el.commandMenu.innerHTML = "";
    state.commandResults = [];
    state.commandIndex = 0;
  }

  function updateCommandMenu() {
    const value = el.input.value;
    if (!value.startsWith("/") || /\s/.test(value)) {
      hideCommandMenu();
      return;
    }
    const query = value.slice(1).toLowerCase();
    const commands = (state.data?.commands || [])
      .filter((command) => command.name.toLowerCase().startsWith(query))
      .slice(0, 9);
    if (commands.length === 0) {
      hideCommandMenu();
      return;
    }
    state.commandResults = commands;
    if (state.commandIndex >= commands.length) state.commandIndex = 0;
    el.commandMenu.innerHTML = commands
      .map(
        (command, index) =>
          `<button class="command-item${index === state.commandIndex ? " selected" : ""}" data-command="${escapeHtml(command.name)}"><span class="cmd">/${escapeHtml(command.name)}</span><span class="cmd-desc">${escapeHtml(command.description || "")}</span></button>`,
      )
      .join("");
    el.commandMenu.classList.remove("hidden");
  }

  function applyCommand(name) {
    el.input.value = `/${name} `;
    hideCommandMenu();
    resizeInput();
    el.input.focus();
  }

  function bind() {
    el.sendBtn.addEventListener("click", send);
    el.stopBtn.addEventListener("click", async () => {
      try {
        await api("/api/cancel", { method: "POST", body: {} });
      } catch (error) {
        toast(error.message, "error");
      }
    });
    el.input.addEventListener("keydown", (event) => {
      if (!el.commandMenu.classList.contains("hidden")) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          state.commandIndex = (state.commandIndex + 1) % state.commandResults.length;
          updateCommandMenu();
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          state.commandIndex =
            (state.commandIndex - 1 + state.commandResults.length) % state.commandResults.length;
          updateCommandMenu();
          return;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey) {
          const command = state.commandResults[state.commandIndex];
          if (command && el.input.value.trim() !== `/${command.name}`) {
            event.preventDefault();
            applyCommand(command.name);
            return;
          }
        }
        if (event.key === "Tab") {
          const command = state.commandResults[state.commandIndex];
          if (command) {
            event.preventDefault();
            applyCommand(command.name);
            return;
          }
        }
        if (event.key === "Escape") {
          event.preventDefault();
          hideCommandMenu();
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void send();
      }
    });
    el.input.addEventListener("input", () => {
      resizeInput();
      updateCommandMenu();
    });
    el.commandMenu.addEventListener("click", (event) => {
      const button = event.target.closest("[data-command]");
      if (button) applyCommand(button.dataset.command);
    });
    el.connectBtn.addEventListener("click", connectModal);
    el.modelPill.addEventListener("click", modelModal);
    el.settingsBtn.addEventListener("click", settingsModal);
    el.setupBanner.querySelector("[data-connect]").addEventListener("click", () => {
      if (state.data?.provider) void modelModal();
      else connectModal();
    });
    document.querySelectorAll("[data-prompt]").forEach((button) => {
      button.addEventListener("click", () => {
        el.input.value = button.dataset.prompt || "";
        resizeInput();
        el.input.focus();
      });
    });

    document.querySelectorAll(".inspector-tab").forEach((button) => {
      button.addEventListener("click", () => {
        state.activeTab = button.dataset.tab;
        document.querySelectorAll(".inspector-tab").forEach((entry) => {
          entry.classList.toggle("active", entry === button);
        });
        document.querySelectorAll(".tab-panel").forEach((panel) => {
          panel.classList.toggle("hidden", panel.dataset.panel !== state.activeTab);
        });
        if (state.activeTab === "mcp" && state.data) renderMcp(state.data.mcp || []);
        if (state.activeTab === "skills" && state.data) {
          renderSkills(state.data.skills || [], true);
        }
      });
    });

    $("mcp-add-btn").addEventListener("click", mcpModal);
    el.mcpCatalogBtn.addEventListener("click", () => void mcpCatalogModal());
    el.updatePill.addEventListener("click", updateModal);
    $("mcp-refresh-btn").addEventListener("click", async () => {
      try {
        await api("/api/mcp/action", { method: "POST", body: { action: "reload" } });
        await refreshState();
        toast("MCP servers reloaded.", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    });
    el.mcpList.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-mcp-action]");
      if (!button) return;
      const action = button.dataset.mcpAction;
      const name = button.dataset.mcpName;
      if (action === "remove" && !confirm(`Remove MCP server "${name}"?`)) return;
      button.disabled = true;
      try {
        await api("/api/mcp/action", { method: "POST", body: { action, name } });
        await refreshState();
        toast(
          action === "remove" ? `MCP server ${name} removed.` : `MCP ${action}: ${name}.`,
          "success",
        );
      } catch (error) {
        toast(error.message, "error");
      } finally {
        button.disabled = false;
      }
    });

    $("skill-add-btn").addEventListener("click", skillModal);
    el.skillCatalogBtn.addEventListener("click", () => void skillCatalogModal());
    $("skills-refresh-btn").addEventListener("click", async () => {
      try {
        await api("/api/skills/action", { method: "POST", body: { action: "reload" } });
        await refreshState();
        toast("Skills reloaded.", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    });
    el.skillSearch.addEventListener("input", () => {
      if (state.data) renderSkills(state.data.skills || [], true);
    });
    el.skillList.addEventListener("click", async (event) => {
      const view = event.target.closest("[data-skill-view]");
      if (view) {
        await skillDetail(view.dataset.skillView);
        return;
      }
      const remove = event.target.closest("[data-skill-remove]");
      if (!remove) return;
      const name = remove.dataset.skillRemove;
      if (!confirm(`Remove skill "${name}"?`)) return;
      remove.disabled = true;
      try {
        await api("/api/skills/action", {
          method: "POST",
          body: {
            action: "remove",
            name,
            scope: remove.dataset.skillSource === "global" ? "global" : "project",
          },
        });
        await refreshState();
        toast(`Skill ${name} removed.`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        remove.disabled = false;
      }
    });

    el.messages.addEventListener("click", (event) => {
      const copy = event.target.closest(".code-copy");
      if (!copy) return;
      const code = copy.parentElement.querySelector("code");
      if (!code) return;
      void copyText(code.textContent || "");
      copy.textContent = "copied";
      setTimeout(() => (copy.textContent = "copy"), 1400);
    });

    el.newSessionBtn.addEventListener("click", async () => {
      try {
        await api("/api/session/new", { method: "POST", body: {} });
        await refreshState({ messages: true });
        toast("New session started.", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    });
    el.undoBtn.addEventListener("click", async () => {
      try {
        const result = await api("/api/undo", { method: "POST", body: {} });
        if (!result.result) {
          toast("Nothing to undo.");
        } else {
          toast(`Restored ${result.result.restored.length} path(s).`, "success");
        }
        await refreshState();
      } catch (error) {
        toast(error.message, "error");
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && el.modalRoot.innerHTML) el.modalRoot.innerHTML = "";
    });
    el.modalRoot.addEventListener("click", (event) => {
      if (event.target === el.modalRoot) el.modalRoot.innerHTML = "";
    });
  }

  async function init() {
    bind();
    await refreshState({ messages: true });
    connectEvents();
    void checkForUpdates(false);
    setInterval(() => {
      if (state.data) renderChrome();
    }, 30_000);
    setInterval(() => void checkForUpdates(false), 6 * 60 * 60 * 1000);
    el.input.focus();
  }

  init();
})();

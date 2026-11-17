import { z } from "zod";
import { defineTool, fail, ok, type ToolContext } from "./types.js";
import { htmlToText, truncate } from "../utils/strings.js";
import { redactSecrets } from "../security/redact.js";

const USER_AGENT = "TagCode/0.1 (terminal coding agent)";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host === "metadata.google.internal") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^0\./.test(host)) return true;
  if (host === "::" || host === "0.0.0.0") return true;
  return false;
}

function validateUrl(raw: string, allowedDomains: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }
  if (isPrivateHostname(url.hostname)) {
    throw new Error(
      `Refusing to fetch a private/local address (${url.hostname}). This protects local services from SSRF.`,
    );
  }
  if (allowedDomains.length > 0) {
    const allowed = allowedDomains.some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain.replace(/^\./, "")}`),
    );
    if (!allowed) {
      throw new Error(
        `Domain ${url.hostname} is not in web.allowedDomains (${allowedDomains.join(", ")}).`,
      );
    }
  }
  return url;
}

async function readLimited(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!response.body) return { text: "", bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        const remaining = Math.max(0, maxBytes - (bytes - value.byteLength));
        text += decoder.decode(value.subarray(0, remaining), { stream: true });
        truncated = true;
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { text, bytes, truncated };
}

export type FetchedDocument = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  text: string;
  truncated: boolean;
};

export async function fetchDocument(
  context: ToolContext,
  rawUrl: string,
  timeoutMs?: number,
): Promise<FetchedDocument> {
  const url = validateUrl(rawUrl, context.config.web.allowedDomains);
  const { signal, cleanup } = combineTimeout(context.signal, timeoutMs ?? context.config.web.timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json,text/plain,text/markdown;q=0.9,*/*;q=0.5" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for ${url.toString()}`);
    }
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const body = await readLimited(response, MAX_BODY_BYTES);
    let text: string;
    if (/json/i.test(contentType)) {
      try {
        text = JSON.stringify(JSON.parse(body.text), null, 2);
      } catch {
        text = body.text;
      }
    } else if (/html/i.test(contentType)) {
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body.text)?.[1]?.trim();
      text = htmlToText(body.text);
      return {
        url: rawUrl,
        finalUrl: response.url || url.toString(),
        status: response.status,
        contentType,
        title: title ? htmlToText(title) : undefined,
        text,
        truncated: body.truncated,
      };
    } else if (/text\/|markdown|xml/i.test(contentType)) {
      text = body.text;
    } else {
      throw new Error(`Unsupported content type "${contentType}". Only text, HTML and JSON are supported.`);
    }
    return {
      url: rawUrl,
      finalUrl: response.url || url.toString(),
      status: response.status,
      contentType,
      text: redactSecrets(text),
      truncated: body.truncated,
    };
  } finally {
    cleanup();
  }
}

function combineTimeout(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

const fetchUrlTool = defineTool({
  name: "fetch_url",
  description:
    "Fetch a public http(s) URL and return readable text. HTML is converted to plain text. Private/local addresses are blocked.",
  permission: "network",
  parameters: z.object({
    url: z.string().min(1),
    timeout_ms: z.number().int().min(1_000).max(120_000).optional(),
  }),
  describe: (input) => ({ summary: `Fetch ${truncate(input.url, 100)}` }),
  async execute(input, context) {
    try {
      const document = await fetchDocument(context, input.url, input.timeout_ms);
      const header = [
        `URL: ${document.finalUrl}`,
        document.title ? `Title: ${document.title}` : undefined,
        `Status: ${document.status} · ${document.contentType}${document.truncated ? " · truncated" : ""}`,
      ]
        .filter(Boolean)
        .join("\n");
      return ok(`${header}\n\n${document.text}`, document);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

const readDocumentationTool = defineTool({
  name: "read_documentation",
  description:
    "Fetch a documentation page and return its title, section headings and readable text. Use for API references and guides.",
  permission: "network",
  parameters: z.object({
    url: z.string().min(1),
    max_chars: z.number().int().min(1000).max(100_000).optional(),
  }),
  describe: (input) => ({ summary: `Read docs at ${truncate(input.url, 100)}` }),
  async execute(input, context) {
    try {
      const document = await fetchDocument(context, input.url);
      const headings: string[] = [];
      if (/html/i.test(document.contentType)) {
        // Headings were stripped by htmlToText; fetch raw quickly only for headings is wasteful,
        // so derive them from lines that look like titles.
        for (const line of document.text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length > 3 && trimmed.length < 90 && /^[A-Z0-9]/.test(trimmed) && !/[.!?:]$/.test(trimmed)) {
            headings.push(trimmed);
          }
          if (headings.length >= 15) break;
        }
      }
      const body = truncate(document.text, input.max_chars ?? 40_000);
      return ok(
        `Documentation: ${document.title ?? document.finalUrl}\nURL: ${document.finalUrl}\n${
          headings.length > 0 ? `\nSections:\n${headings.map((heading) => `- ${heading}`).join("\n")}\n` : ""
        }\n${body}`,
        { ...document, headings },
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

type SearchResult = { title: string; url: string; description: string };

async function braveSearch(
  query: string,
  maxResults: number,
  apiKey: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(maxResults, 20)));
  const { signal: combined, cleanup } = combineTimeout(signal, timeoutMs);
  try {
    const response = await fetch(url, {
      signal: combined,
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
        "User-Agent": USER_AGENT,
      },
    });
    if (!response.ok) {
      throw new Error(`Brave Search returned HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (data.web?.results ?? [])
      .filter((result) => result.url)
      .map((result) => ({
        title: htmlToText(result.title ?? ""),
        url: result.url!,
        description: htmlToText(result.description ?? ""),
      }));
  } finally {
    cleanup();
  }
}

async function tavilySearch(
  query: string,
  maxResults: number,
  apiKey: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const { signal: combined, cleanup } = combineTimeout(signal, timeoutMs);
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal: combined,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: "basic",
        include_answer: false,
      }),
    });
    if (!response.ok) {
      throw new Error(`Tavily returned HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (data.results ?? [])
      .filter((result) => result.url)
      .map((result) => ({
        title: result.title ?? "",
        url: result.url!,
        description: result.content ?? "",
      }));
  } finally {
    cleanup();
  }
}

const webSearchTool = defineTool({
  name: "web_search",
  description:
    "Search the web using the configured provider (Brave or Tavily). Requires web.searchProvider and an API key, so it is disabled by default.",
  permission: "network",
  parameters: z.object({
    query: z.string().min(1),
    max_results: z.number().int().min(1).max(20).optional(),
  }),
  describe: (input) => ({ summary: `Web search: ${truncate(input.query, 80)}` }),
  async execute(input, context) {
    const provider = context.config.web.searchProvider;
    if (!provider) {
      return fail(
        "Web search is not configured. Set `web.searchProvider` to \"brave\" or \"tavily\" in config.json and store an API key (web.searchApiKeyEnv or TAGCODE_WEB_API_KEY).",
      );
    }
    const envName =
      context.config.web.searchApiKeyEnv ??
      (provider === "brave" ? "BRAVE_API_KEY" : "TAVILY_API_KEY");
    const apiKey = await context.secrets.get("web-search", envName);
    if (!apiKey) {
      return fail(`Missing search API key. Set ${envName} or store a key for provider "web-search".`);
    }
    const max = input.max_results ?? context.config.web.maxResults;
    try {
      const results =
        provider === "brave"
          ? await braveSearch(input.query, max, apiKey, context.signal, context.config.web.timeoutMs)
          : await tavilySearch(input.query, max, apiKey, context.signal, context.config.web.timeoutMs);
      if (results.length === 0) return ok(`No results for "${input.query}".`, []);
      return ok(
        results
          .slice(0, max)
          .map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${truncate(result.description, 300)}`)
          .join("\n\n"),
        results,
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

export const webTools = [fetchUrlTool, readDocumentationTool, webSearchTool];

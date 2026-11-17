export type SSEEvent = {
  event?: string;
  data: string;
  id?: string;
};

/**
 * Incremental server-sent-events parser. Works with chunk boundaries splitting
 * fields or UTF-8 sequences.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary || boundary.index === undefined) break;
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const parsed = parseBlock(raw);
        if (parsed) yield parsed;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const parsed = parseBlock(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    // Consumers may stop early (for example at an SSE `[DONE]` marker).
    // Cancelling the body lets the HTTP client release the socket instead of
    // leaving the CLI process alive on an idle keep-alive connection.
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or locked by the platform.
    }
    try {
      reader.releaseLock();
    } catch {
      // Releasing twice is harmless but not all runtimes allow it.
    }
  }
}

function parseBlock(raw: string): SSEEvent | null {
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }
  if (dataLines.length === 0) return null;
  return { data: dataLines.join("\n"), event, id };
}

/** Parse an SSE response into JSON objects, ignoring comments and [DONE]. */
export async function* parseSSEJson<T = unknown>(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  for await (const event of parseSSE(body, signal)) {
    if (event.data === "[DONE]") return;
    try {
      yield JSON.parse(event.data) as T;
    } catch {
      // Ignore malformed keep-alive frames rather than aborting the stream.
    }
  }
}

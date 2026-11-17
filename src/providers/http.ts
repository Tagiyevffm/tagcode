import { ProviderError } from "../core/errors.js";
import { redactSecrets } from "../security/redact.js";

export type HttpOptions = {
  providerId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export function joinUrl(baseUrl: string, pathname: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = pathname.startsWith("/") ? pathname : `/${pathname}`;
  // Avoid `.../v1/v1/...` when the configured base URL already includes the version.
  if (/\/v1$/.test(base) && suffix.startsWith("/v1/")) {
    return `${base}${suffix.slice(3)}`;
  }
  return `${base}${suffix}`;
}

export function combineSignals(
  timeoutMs: number | undefined,
  external?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = timeoutMs && timeoutMs > 0 ? setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs) : undefined;
  // A pending request is kept alive by its socket; the watchdog must not keep
  // an otherwise-finished CLI process alive for the full timeout.
  timeout?.unref();
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeout) clearTimeout(timeout);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

async function describeErrorResponse(response: Response): Promise<string> {
  let body = "";
  try {
    body = (await response.text()).slice(0, 2000);
  } catch {
    // ignore
  }
  const redacted = redactSecrets(body.trim());
  return redacted ? `${response.status} ${response.statusText}: ${redacted}` : `${response.status} ${response.statusText}`;
}

export async function requestStream(
  url: string,
  init: RequestInit,
  options: HttpOptions,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { signal, cleanup } = combineSignals(options.timeoutMs ?? 120_000, options.signal);
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal });
  } catch (error) {
    cleanup();
    if (signal.aborted) {
      throw new ProviderError(
        options.signal?.aborted ? "Request cancelled" : "Request timed out",
        { providerId: options.providerId, cause: error },
      );
    }
    throw new ProviderError(
      `Could not reach ${options.providerId}: ${error instanceof Error ? error.message : String(error)}`,
      { providerId: options.providerId, cause: error },
    );
  }

  if (!response.ok) {
    const message = await describeErrorResponse(response);
    cleanup();
    throw new ProviderError(`${options.providerId} request failed (${message})`, {
      providerId: options.providerId,
      status: response.status,
    });
  }
  if (!response.body) {
    cleanup();
    throw new ProviderError(`${options.providerId} returned an empty response body`, {
      providerId: options.providerId,
      status: response.status,
    });
  }
  return response;
}

export async function requestJson<T>(
  url: string,
  init: RequestInit,
  options: HttpOptions & { retries?: number },
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const { signal, cleanup } = combineSignals(options.timeoutMs ?? 30_000, options.signal);
    try {
      const response = await fetchImpl(url, { ...init, signal });
      if (!response.ok) {
        const message = await describeErrorResponse(response);
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < retries) {
          await delay(400 * 2 ** attempt, options.signal);
          continue;
        }
        throw new ProviderError(`${options.providerId} request failed (${message})`, {
          providerId: options.providerId,
          status: response.status,
        });
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (error instanceof ProviderError) throw error;
      if (options.signal?.aborted) {
        throw new ProviderError("Request cancelled", { providerId: options.providerId, cause: error });
      }
      if (attempt < retries) {
        await delay(400 * 2 ** attempt, options.signal);
        continue;
      }
      throw new ProviderError(
        `Could not reach ${options.providerId}: ${error instanceof Error ? error.message : String(error)}`,
        { providerId: options.providerId, cause: error },
      );
    } finally {
      cleanup();
    }
  }
  throw new ProviderError(`Request to ${options.providerId} failed`, {
    providerId: options.providerId,
    cause: lastError,
  });
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run a streaming request while releasing the HTTP timeout once headers
 * arrive; long generations must not be killed by a request timeout.
 */
export async function openEventStream(
  url: string,
  init: RequestInit,
  options: HttpOptions,
): Promise<Response> {
  return requestStream(url, init, options);
}

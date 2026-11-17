export class TagCodeError extends Error {
  readonly code: string;
  constructor(message: string, code = "tagcode_error", options?: ErrorOptions) {
    super(message, options);
    this.name = "TagCodeError";
    this.code = code;
  }
}

export class ConfigError extends TagCodeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "config_error", options);
    this.name = "ConfigError";
  }
}

export class ProviderError extends TagCodeError {
  readonly status?: number;
  readonly providerId?: string;
  constructor(message: string, opts: { status?: number; providerId?: string; cause?: unknown } = {}) {
    super(message, "provider_error", { cause: opts.cause });
    this.name = "ProviderError";
    this.status = opts.status;
    this.providerId = opts.providerId;
  }
}

export class PermissionDeniedError extends TagCodeError {
  constructor(message: string) {
    super(message, "permission_denied");
    this.name = "PermissionDeniedError";
  }
}

export class PathOutsideWorkspaceError extends TagCodeError {
  constructor(target: string) {
    super(`Path is outside the workspace: ${target}`, "path_outside_workspace");
    this.name = "PathOutsideWorkspaceError";
  }
}

export class CancelledError extends TagCodeError {
  constructor(message = "Operation cancelled") {
    super(message, "cancelled");
    this.name = "CancelledError";
  }
}

export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

export function errorMessage(value: unknown): string {
  return toError(value).message;
}

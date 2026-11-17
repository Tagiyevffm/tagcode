const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, replacement: "sk-ant-[REDACTED]" },
  { pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{16,}\b/g, replacement: "sk-[REDACTED]" },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replacement: "gh*_[REDACTED]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: "github_pat_[REDACTED]" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "xox*-[REDACTED]" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: "AIza[REDACTED]" },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: "AWS[REDACTED]" },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "[JWT REDACTED]" },
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, replacement: "[PRIVATE KEY REDACTED]" },
  { pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, replacement: "$1 [REDACTED]" },
  { pattern: /\b(api[_-]?key|secret|token|password|passwd|authorization)\s*[:=]\s*["']?[^\s"',}]{8,}/gi, replacement: "$1=[REDACTED]" },
  { pattern: /\b(?:hf|glpat|npm|pypi)-[A-Za-z0-9_-]{16,}\b/g, replacement: "[TOKEN REDACTED]" },
];

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|apikey|secret|token|password|passwd|authorization|cookie|credential|private[_-]?key)/i;

/** Redact well-known secret formats from arbitrary text. */
export function redactSecrets(text: string, knownSecrets: string[] = []): string {
  if (!text) return text;
  let output = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 6) {
      output = output.split(secret).join("[REDACTED]");
    }
  }
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/** Recursively redact values under sensitive keys. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth limit]";
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

export function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "********";
  return `${secret.slice(0, 3)}…${secret.slice(-2)}`;
}

/** Collect secrets present in the environment so they never leak into logs. */
export function environmentSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (/(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i.test(key)) {
      secrets.push(value);
    }
  }
  return secrets;
}

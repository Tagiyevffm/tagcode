const ANSI_PATTERN = new RegExp(
  // eslint-disable-next-line no-control-regex
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  "g",
);

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function truncate(value: string, maxLength: number, suffix = "…"): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;
  if (maxLength <= suffix.length) return value.slice(0, maxLength);
  return value.slice(0, maxLength - suffix.length) + suffix;
}

/** Keep the beginning and the end, eliding the middle. */
export function truncateMiddle(value: string, maxLength: number, marker = "\n… [truncated] …\n"): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= marker.length + 10) return truncate(value, maxLength);
  const available = maxLength - marker.length;
  const head = Math.ceil(available * 0.6);
  const tail = Math.floor(available * 0.4);
  return value.slice(0, head) + marker + value.slice(value.length - tail);
}

export function firstLine(value: string, maxLength = 120): string {
  const line = value.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return truncate(line.trim(), maxLength);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) < 1000) return String(Math.round(value));
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function slugify(value: string, fallback = "item"): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || fallback;
}

export function isProbablyUrl(value: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(value.trim());
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Convert an HTML document into readable plain text (no external deps). */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|pre|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n\s*\n+/g, "\n\n")
      .trim(),
  );
}

export function wrapText(value: string, width: number): string[] {
  const safeWidth = Math.max(10, width);
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    if (paragraph.length <= safeWidth) {
      lines.push(paragraph);
      continue;
    }
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!current) {
        current = word;
      } else if (current.length + 1 + word.length <= safeWidth) {
        current += ` ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
      while (current.length > safeWidth) {
        lines.push(current.slice(0, safeWidth));
        current = current.slice(safeWidth);
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

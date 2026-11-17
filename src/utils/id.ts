import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomString(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/** Sortable, collision-resistant id: prefix + timestamp + random suffix. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, "0");
  return `${prefix}_${time}${randomString(6)}`;
}

export function newSessionId(): string {
  return newId("ses");
}

export function newCallId(): string {
  return newId("call");
}

export function newCheckpointId(): string {
  return newId("cp");
}

export function shortId(id: string, length = 8): string {
  const parts = id.split("_");
  const tail = parts[parts.length - 1] ?? id;
  return tail.slice(0, length);
}

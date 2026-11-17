import type { SessionController } from "../controller.js";

export type CommandResult = {
  handled: boolean;
  output?: string;
  /** The CLI/TUI should exit. */
  exit?: boolean;
  /** The UI should rebuild its transcript from controller messages. */
  resetView?: boolean;
};

export type CommandInput = {
  args: string[];
  /** Everything after the command name, with quotes preserved in args. */
  raw: string;
  controller: SessionController;
};

export type CommandDefinition = {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  handler: (input: CommandInput) => Promise<Omit<CommandResult, "handled"> | string | void>;
};

/** Tokenize a slash-command line, supporting single and double quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition>();

  constructor(definitions: CommandDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: CommandDefinition): void {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(definition.name)) {
      throw new Error(`Invalid command name: ${definition.name}`);
    }
    if (this.commands.has(definition.name)) {
      throw new Error(`Command already registered: ${definition.name}`);
    }
    this.commands.set(definition.name, definition);
    for (const alias of definition.aliases ?? []) {
      if (this.commands.has(alias)) throw new Error(`Command already registered: ${alias}`);
      this.commands.set(alias, definition);
    }
  }

  get(name: string): CommandDefinition | undefined {
    return this.commands.get(name);
  }

  list(): CommandDefinition[] {
    const seen = new Set<CommandDefinition>();
    const result: CommandDefinition[] = [];
    for (const definition of this.commands.values()) {
      if (seen.has(definition)) continue;
      seen.add(definition);
      result.push(definition);
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async execute(line: string, controller: SessionController): Promise<CommandResult> {
    const input = line.trim();
    if (!input.startsWith("/")) return { handled: false };
    const body = input.slice(1).trim();
    if (!body) return { handled: true, output: "Type /help to see the available commands." };
    const [name, ...args] = tokenize(body);
    if (!name) return { handled: true, output: "Type /help to see the available commands." };
    const definition = this.commands.get(name.toLowerCase());
    if (!definition) {
      return { handled: true, output: `Unknown command: /${name}. Type /help for the list.` };
    }
    const raw = body.slice(name.length).trim();
    const result = await definition.handler({ args, raw, controller });
    if (typeof result === "string") return { handled: true, output: result };
    return { handled: true, ...(result ?? {}) };
  }
}

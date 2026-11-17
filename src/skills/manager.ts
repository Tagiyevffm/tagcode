import type { Skill } from "./types.js";
import type { SkillLoader } from "./loader.js";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "your", "you",
  "build", "create", "make", "using", "use", "add", "new", "please", "help",
  "code", "project", "want", "need", "should", "would", "could", "app",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ""))
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

export type SkillManagerOptions = {
  maxActive: number;
  autoSelect: boolean;
};

/**
 * Selects a small number of relevant skills per task instead of loading every
 * skill into the prompt.
 */
export class SkillManager {
  private skills: Skill[] = [];
  private explicit = new Set<string>();
  private auto = new Set<string>();
  private readonly listeners = new Set<(skills: Skill[]) => void>();

  constructor(
    private readonly loader: SkillLoader,
    private readonly options: SkillManagerOptions,
  ) {}

  async reload(): Promise<Skill[]> {
    const discovered = await this.loader.discover();
    this.skills = discovered.map((entry) => entry.skill);
    this.notify();
    return this.skills;
  }

  onChange(listener: (skills: Skill[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.skills);
      } catch {
        // Listeners are UI-level and must not break skill loading.
      }
    }
  }

  list(): Skill[] {
    return this.skills;
  }

  valid(): Skill[] {
    return this.skills.filter((skill) => skill.valid);
  }

  get(name: string): Skill | undefined {
    return this.skills.find((skill) => skill.name === name);
  }

  async readInstructions(name: string): Promise<string | undefined> {
    const skill = this.get(name);
    if (!skill) return undefined;
    return this.formatSkill(skill, 12_000);
  }

  activate(name: string): Skill | undefined {
    const skill = this.get(name);
    if (!skill || !skill.valid) return undefined;
    this.explicit.add(name);
    this.enforceLimit();
    this.notify();
    return skill;
  }

  deactivate(name: string): void {
    this.explicit.delete(name);
    this.auto.delete(name);
    this.notify();
  }

  clearAuto(): void {
    this.auto.clear();
  }

  getActiveNames(): string[] {
    return this.activeSkills().map((skill) => skill.name);
  }

  activeSkills(): Skill[] {
    const names = [...new Set([...this.explicit, ...this.auto])];
    const active: Skill[] = [];
    for (const name of names) {
      const skill = this.get(name);
      if (skill?.valid) active.push(skill);
      if (active.length >= this.options.maxActive) break;
    }
    return active;
  }

  /** Score skills against the task and activate the best matches. */
  selectForTask(task: string): Skill[] {
    this.auto.clear();
    if (!this.options.autoSelect) {
      this.notify();
      return this.activeSkills();
    }
    if (this.options.maxActive <= this.explicit.size) {
      this.notify();
      return this.activeSkills();
    }
    const terms = tokenize(task);
    const lower = task.toLowerCase();
    const scored: Array<{ skill: Skill; score: number }> = [];

    for (const skill of this.valid()) {
      const nameTokens = tokenize(skill.name.replace(/-/g, " "));
      const description = skill.description.toLowerCase();
      const tags = (skill.metadata.tags ?? []).map((tag) => tag.toLowerCase());
      let score = 0;
      for (const term of terms) {
        if (nameTokens.includes(term) || lower.includes(term)) score += 4;
        if (description.includes(term)) score += 2;
        if (tags.some((tag) => tag.includes(term))) score += 3;
      }
      if (lower.includes(skill.name.toLowerCase())) score += 6;
      if (score >= 4) scored.push({ skill, score });
    }

    scored.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
    const capacity = Math.max(0, this.options.maxActive - this.explicit.size);
    for (const entry of scored.slice(0, capacity)) {
      this.auto.add(entry.skill.name);
    }
    this.notify();
    return this.activeSkills();
  }

  private enforceLimit(): void {
    if (this.explicit.size <= this.options.maxActive) return;
    const keep = [...this.explicit].slice(0, this.options.maxActive);
    this.explicit = new Set(keep);
  }

  buildIndex(limit = 30): string {
    const skills = this.valid().slice(0, limit);
    if (skills.length === 0) return "No skills are installed.";
    const lines = skills.map(
      (skill) => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ").slice(0, 220)}`,
    );
    const total = this.valid().length;
    if (total > skills.length) lines.push(`… and ${total - skills.length} more (use /skills list).`);
    return lines.join("\n");
  }

  formatActiveInstructions(maxChars = 24_000): string {
    const active = this.activeSkills();
    if (active.length === 0) return "";
    const parts: string[] = [];
    let used = 0;
    for (const skill of active) {
      const block = this.formatSkill(skill, Math.min(12_000, maxChars - used));
      if (!block) continue;
      if (used + block.length > maxChars) break;
      parts.push(block);
      used += block.length;
    }
    return parts.join("\n\n");
  }

  private formatSkill(skill: Skill, maxChars: number): string {
    const header = `<skill name="${skill.name}" path="${skill.directory}">\n`;
    const footer = "\n</skill>";
    const available = Math.max(0, maxChars - header.length - footer.length);
    const body = skill.instructions.length > available
      ? `${skill.instructions.slice(0, available)}\n… (skill truncated)`
      : skill.instructions;
    return `${header}${body}${footer}`;
  }
}

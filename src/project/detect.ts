import { promises as fs } from "node:fs";
import path from "node:path";
import { walkFiles } from "../utils/glob.js";
import { formatBytes } from "../utils/strings.js";

export type LanguageStat = { name: string; files: number; bytes: number };
export type FrameworkInfo = { name: string; evidence: string };

export type ProjectCommands = {
  install?: string;
  test?: string;
  build?: string;
  lint?: string;
  typecheck?: string;
  dev?: string;
};

export type ProjectInfo = {
  root: string;
  name?: string;
  fileCount: number;
  totalBytes: number;
  languages: LanguageStat[];
  frameworks: FrameworkInfo[];
  packageManagers: string[];
  manifests: string[];
  scripts: Record<string, string>;
  commands: ProjectCommands;
  hasGit: boolean;
  branch?: string;
  instructionFiles: string[];
  warnings: string[];
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".cs": "C#",
  ".cpp": "C++",
  ".cc": "C++",
  ".cxx": "C++",
  ".hpp": "C++",
  ".h": "C",
  ".c": "C",
  ".rb": "Ruby",
  ".php": "PHP",
  ".swift": "Swift",
  ".dart": "Dart",
  ".scala": "Scala",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".lua": "Lua",
  ".sh": "Shell",
  ".ps1": "PowerShell",
  ".sql": "SQL",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "SCSS",
  ".md": "Markdown",
  ".json": "JSON",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".toml": "TOML",
};

const FRAMEWORK_DEPENDENCIES: Record<string, string> = {
  next: "Next.js",
  react: "React",
  "react-native": "React Native",
  vue: "Vue",
  nuxt: "Nuxt",
  svelte: "Svelte",
  "@angular/core": "Angular",
  express: "Express",
  fastify: "Fastify",
  koa: "Koa",
  "@nestjs/core": "NestJS",
  electron: "Electron",
  tailwindcss: "Tailwind CSS",
  vitest: "Vitest",
  jest: "Jest",
  "@playwright/test": "Playwright",
  prisma: "Prisma",
  "@prisma/client": "Prisma",
  "drizzle-orm": "Drizzle ORM",
  typeorm: "TypeORM",
  sequelize: "Sequelize",
  mongoose: "Mongoose",
  graphql: "GraphQL",
  trpc: "tRPC",
  vite: "Vite",
  webpack: "Webpack",
  esbuild: "esbuild",
  hono: "Hono",
  astro: "Astro",
  remix: "Remix",
};

const PYTHON_DEPENDENCIES: Record<string, string> = {
  fastapi: "FastAPI",
  flask: "Flask",
  django: "Django",
  sqlalchemy: "SQLAlchemy",
  pydantic: "Pydantic",
  pytest: "pytest",
  uvicorn: "Uvicorn",
  celery: "Celery",
  numpy: "NumPy",
  pandas: "pandas",
  torch: "PyTorch",
  tensorflow: "TensorFlow",
  streamlit: "Streamlit",
  langchain: "LangChain",
  "pytest-django": "pytest-django",
};

async function exists(root: string, relative: string): Promise<boolean> {
  return fs
    .stat(path.join(root, relative))
    .then(() => true)
    .catch(() => false);
}

async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function detectPackageManager(files: Set<string>, packageJson?: { packageManager?: string }): string | undefined {
  if (packageJson?.packageManager) {
    return packageJson.packageManager.split("@")[0];
  }
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("bun.lockb") || files.has("bun.lock")) return "bun";
  if (files.has("package-lock.json") || files.has("package.json")) return "npm";
  return undefined;
}

function pyProjectDependencies(text: string): string[] {
  const match = /\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text);
  if (!match) return [];
  return [...match[1]!.matchAll(/["']([A-Za-z0-9_.-]+)/g)].map((entry) => entry[1]!.toLowerCase());
}

function uniqueByName(items: Array<{ name: string; evidence: string }>): FrameworkInfo[] {
  const map = new Map<string, FrameworkInfo>();
  for (const item of items) {
    const existing = map.get(item.name);
    if (!existing) map.set(item.name, item);
    else if (!existing.evidence.includes(item.evidence)) existing.evidence += `, ${item.evidence}`;
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function detectProject(rootInput: string): Promise<ProjectInfo> {
  const root = path.resolve(rootInput);
  const warnings: string[] = [];
  const files = await walkFiles(root, { maxFiles: 20_000 });
  const fileSet = new Set(files.map((file) => file.relativePath));

  const languageMap = new Map<string, LanguageStat>();
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
    const extension = path.extname(file.relativePath).toLowerCase();
    const language = LANGUAGE_BY_EXTENSION[extension];
    if (!language) continue;
    const current = languageMap.get(language) ?? { name: language, files: 0, bytes: 0 };
    current.files++;
    current.bytes += file.size;
    languageMap.set(language, current);
  }
  const languages = [...languageMap.values()].sort((a, b) => b.files - a.files);

  const manifests: string[] = [];
  const frameworks: FrameworkInfo[] = [];
  const packageManagers: string[] = [];
  const scripts: Record<string, string> = {};
  const commands: ProjectCommands = {};

  const manifestCandidates = [
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "composer.json",
    "Gemfile",
    "pubspec.yaml",
    "deno.json",
    "deno.jsonc",
    "bunfig.toml",
    "Makefile",
    "docker-compose.yml",
    "Dockerfile",
  ];
  for (const candidate of manifestCandidates) {
    if (fileSet.has(candidate)) manifests.push(candidate);
  }
  for (const file of files) {
    if (file.relativePath.endsWith(".csproj") || file.relativePath.endsWith(".sln")) {
      manifests.push(file.relativePath);
    }
  }

  let projectName: string | undefined;
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = await readJsonFile<{
    name?: string;
    packageManager?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(packageJsonPath);

  if (packageJson) {
    projectName = packageJson.name;
    const pm = detectPackageManager(fileSet, packageJson);
    if (pm) {
      packageManagers.push(pm);
      commands.install = `${pm} install`;
    }
    Object.assign(scripts, packageJson.scripts ?? {});
    const runScript = (name: string) => `${pm ?? "npm"} run ${name}`;
    if (scripts.test) commands.test = pm === "npm" || !pm ? "npm test" : `${pm} test`;
    if (scripts.build) commands.build = runScript("build");
    if (scripts.lint) commands.lint = runScript("lint");
    if (scripts.typecheck) commands.typecheck = runScript("typecheck");
    else if (scripts["type-check"]) commands.typecheck = runScript("type-check");
    else if (scripts.tsc) commands.typecheck = runScript("tsc");
    if (scripts.dev) commands.dev = runScript("dev");

    const deps = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
    for (const [dependency, label] of Object.entries(FRAMEWORK_DEPENDENCIES)) {
      if (deps[dependency]) {
        frameworks.push({ name: label, evidence: `dependency "${dependency}"` });
      }
    }
  }

  // Python
  if (fileSet.has("requirements.txt")) {
    const requirements = await fs.readFile(path.join(root, "requirements.txt"), "utf8").catch(() => "");
    for (const [dependency, label] of Object.entries(PYTHON_DEPENDENCIES)) {
      if (new RegExp(`^\\s*${dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "im").test(requirements)) {
        frameworks.push({ name: label, evidence: `requirements.txt` });
      }
    }
    commands.test ??= "pytest";
    commands.install ??= "python -m pip install -r requirements.txt";
  }
  if (fileSet.has("pyproject.toml")) {
    const pyproject = await fs.readFile(path.join(root, "pyproject.toml"), "utf8").catch(() => "");
    for (const dependency of pyProjectDependencies(pyproject)) {
      const label = PYTHON_DEPENDENCIES[dependency];
      if (label) frameworks.push({ name: label, evidence: "pyproject.toml" });
    }
    if (/\[tool\.poetry\]/.test(pyproject)) {
      packageManagers.push("poetry");
      commands.install ??= "poetry install";
      commands.test ??= "poetry run pytest";
    } else if (/\[tool\.uv\]/.test(pyproject) || fileSet.has("uv.lock")) {
      packageManagers.push("uv");
      commands.install ??= "uv sync";
      commands.test ??= "uv run pytest";
    } else {
      packageManagers.push("pip");
      commands.install ??= "python -m pip install -e .";
      commands.test ??= "pytest";
    }
    if (/\[tool\.ruff/.test(pyproject)) commands.lint ??= "ruff check .";
    if (/\[tool\.mypy/.test(pyproject)) commands.typecheck ??= "mypy .";
  }
  if (fileSet.has("manage.py")) frameworks.push({ name: "Django", evidence: "manage.py" });
  if (fileSet.has("Dockerfile")) frameworks.push({ name: "Docker", evidence: "Dockerfile" });

  // Rust / Go / JVM / .NET / PHP / Ruby / Dart
  if (fileSet.has("Cargo.toml")) {
    packageManagers.push("cargo");
    commands.build ??= "cargo build";
    commands.test ??= "cargo test";
    commands.lint ??= "cargo clippy --all-targets";
    commands.typecheck ??= "cargo check";
    commands.install ??= "cargo fetch";
  }
  if (fileSet.has("go.mod")) {
    packageManagers.push("go modules");
    commands.build ??= "go build ./...";
    commands.test ??= "go test ./...";
    commands.lint ??= "go vet ./...";
    commands.typecheck ??= "go vet ./...";
  }
  if (fileSet.has("pom.xml")) {
    packageManagers.push("maven");
    commands.build ??= "mvn -q package";
    commands.test ??= "mvn -q test";
  }
  if (fileSet.has("build.gradle") || fileSet.has("build.gradle.kts")) {
    packageManagers.push("gradle");
    commands.build ??= "gradle build";
    commands.test ??= "gradle test";
  }
  if (fileSet.has("composer.json")) {
    packageManagers.push("composer");
    frameworks.push({ name: "PHP", evidence: "composer.json" });
    commands.install ??= "composer install";
    commands.test ??= "composer test";
  }
  if (fileSet.has("Gemfile")) {
    packageManagers.push("bundler");
    commands.install ??= "bundle install";
    commands.test ??= "bundle exec rspec";
  }
  if (fileSet.has("pubspec.yaml")) {
    packageManagers.push("pub");
    frameworks.push({ name: "Flutter", evidence: "pubspec.yaml" });
    commands.install ??= "flutter pub get";
    commands.test ??= "flutter test";
  }
  if (files.some((file) => file.relativePath.endsWith(".csproj"))) {
    packageManagers.push("dotnet");
    commands.build ??= "dotnet build";
    commands.test ??= "dotnet test";
  }

  // Framework file evidence
  if (fileSet.has("next.config.js") || fileSet.has("next.config.mjs") || fileSet.has("next.config.ts")) {
    frameworks.push({ name: "Next.js", evidence: "next.config.*" });
  }
  if (fileSet.has("vite.config.ts") || fileSet.has("vite.config.js")) {
    frameworks.push({ name: "Vite", evidence: "vite.config.*" });
  }
  if (fileSet.has("angular.json")) frameworks.push({ name: "Angular", evidence: "angular.json" });
  if (fileSet.has("svelte.config.js")) frameworks.push({ name: "Svelte", evidence: "svelte.config.js" });
  if (fileSet.has("nuxt.config.ts") || fileSet.has("nuxt.config.js")) {
    frameworks.push({ name: "Nuxt", evidence: "nuxt.config.*" });
  }
  if (fileSet.has("tailwind.config.js") || fileSet.has("tailwind.config.ts")) {
    frameworks.push({ name: "Tailwind CSS", evidence: "tailwind.config.*" });
  }
  if (fileSet.has("tsconfig.json") && !commands.typecheck) commands.typecheck = "npx tsc --noEmit";

  const instructionFiles = ["AGENTS.md", "CLAUDE.md", ".tagcode/AGENTS.md", "README.md"].filter((file) =>
    fileSet.has(file),
  );

  let branch: string | undefined;
  const hasGit = await exists(root, ".git");
  if (hasGit) {
    try {
      const head = await fs.readFile(path.join(root, ".git", "HEAD"), "utf8");
      const match = /ref:\s+refs\/heads\/(.+)/.exec(head.trim());
      branch = match?.[1] ?? head.trim().slice(0, 12);
    } catch {
      // Worktree .git file or unreadable; branch stays unknown.
    }
  }

  if (files.length >= 20_000) warnings.push("File scan stopped at 20,000 files; statistics are partial.");

  return {
    root,
    name: projectName,
    fileCount: files.length,
    totalBytes,
    languages,
    frameworks: uniqueByName(frameworks),
    packageManagers: [...new Set(packageManagers)],
    manifests,
    scripts,
    commands,
    hasGit,
    branch,
    instructionFiles,
    warnings,
  };
}

export function summarizeProject(info: ProjectInfo): string {
  const lines: string[] = [];
  lines.push(`Project: ${info.name ?? path.basename(info.root)}`);
  lines.push(`Root: ${info.root}`);
  lines.push(`Files: ${info.fileCount} (${formatBytes(info.totalBytes)})`);
  lines.push(
    `Languages: ${
      info.languages
        .filter((language) => !["JSON", "Markdown", "YAML", "TOML", "HTML", "CSS", "SCSS"].includes(language.name))
        .slice(0, 6)
        .map((language) => `${language.name} (${language.files})`)
        .join(", ") || "unknown"
    }`,
  );
  if (info.frameworks.length > 0) {
    lines.push(`Frameworks: ${info.frameworks.map((framework) => framework.name).join(", ")}`);
  }
  if (info.packageManagers.length > 0) {
    lines.push(`Package managers: ${info.packageManagers.join(", ")}`);
  }
  if (info.manifests.length > 0) {
    lines.push(`Manifests: ${info.manifests.slice(0, 12).join(", ")}`);
  }
  const commandEntries = Object.entries(info.commands).filter(([, value]) => Boolean(value));
  if (commandEntries.length > 0) {
    lines.push("Commands:");
    for (const [name, value] of commandEntries) lines.push(`  ${name}: ${value}`);
  }
  if (info.hasGit) lines.push(`Git: yes${info.branch ? ` (branch ${info.branch})` : ""}`);
  if (info.instructionFiles.length > 0) {
    lines.push(`Instruction files: ${info.instructionFiles.join(", ")}`);
  }
  if (info.warnings.length > 0) lines.push(`Warnings: ${info.warnings.join("; ")}`);
  return lines.join("\n");
}

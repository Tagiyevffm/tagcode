# Skills

Skills are reusable instruction packages that teach TagCode how to perform a
specialized workflow. TagCode follows the Agent Skills `SKILL.md` format and
loads only relevant skills per task to save context.

Implementation: `src/skills/`.

## Layout

```text
my-skill/
  SKILL.md
  references/
    documentation.md
  scripts/
    helper.py
  assets/
    template.json
```

A skill directory must contain `SKILL.md` with YAML frontmatter:

```markdown
---
name: fastapi-service
description: Build FastAPI services with SQLite, pytest and the project's conventions. Use when creating or extending a Python API.
version: 1.0.0
author: you
tags: [python, fastapi]
---

# FastAPI service

## When to use

Use this skill when the task mentions FastAPI endpoints, SQLite models or
pytest fixtures.

## Procedure

1. Inspect `pyproject.toml` and existing routers.
2. Add models and migrations before routes.
3. Add tests and run `pytest -q`.
4. Report changed files and commands.

## Verification checklist

- Endpoints validate input with Pydantic.
- Tests cover success and error paths.
```

Rules:

- `name` is required, lowercase kebab-case, at most 64 characters.
- `description` is required, at most 1024 characters, and should say when to use
  the skill.
- Instructions must be non-trivial (at least 20 characters).
- References to `references/`, `scripts/` or `assets/` must stay inside the skill
  directory. Missing files produce warnings; escaping paths are errors.
- Scripts are never executed automatically.
- If a top-level scalar value contains an unquoted `: ` (common in generated
  descriptions), TagCode recovers by reading the rest of the line as plain text
  and reports a warning instead of rejecting the whole skill. Quoting the value
  is still the preferred fix.

## Discovery

Skill roots, in precedence order:

1. `<project>/.tagcode/skills/` (project)
2. `~/.tagcode/skills/` (global)
3. `skills.directories` from config (configured)

A project skill wins over a global skill with the same name. Disabled names in
`skills.disabled` are skipped. `skills.autoSelect` and `skills.maxActive`
control automatic activation.

## Commands

```bash
tgc skills list
tgc skills inspect my-skill
tgc skills install ./path/to/skill
tgc skills install https://github.com/user/skill-repo
tgc skills remove my-skill --yes
tgc skills update my-skill
tgc skills search fastapi            # requires skills.registryUrl
tgc skills create "FastAPI conventions we use"
tgc skills validate ./path/to/skill
tgc skills reload
```

Slash equivalents: `/skills list|active|index|inspect|reload|use|off|install|remove|update|search|create|validate`.

`--global` targets `~/.tagcode/skills`; the default is project scope.
`--force` replaces an existing skill on install.

### Desktop panel

The **Skills** tab lists installed skills with source, validity, description and
tags. Search filters locally; **View** opens the full `SKILL.md` as rendered
Markdown with metadata and validation errors. **+** installs from Git, from a
local folder, or generates a new skill from a description using the active
model. Removal and reload are available in the same panel. New skills are
reloaded immediately and become available to the agent.

Choose **▦** to browse the built-in skill catalog. Every entry has a rendered
preview of the complete instructions, metadata, tags and a project/global
install selector. The catalog ships with:

| Skill | Purpose |
| --- | --- |
| `code-review` | Review a diff for correctness, security and missing tests |
| `test-writer` | Add focused tests that match the project framework |
| `bug-hunt` | Reproduce, isolate and fix a defect |
| `security-audit` | Audit injection, secret exposure and permission bypasses |
| `docs-writer` | Keep README, docs, changelog and status in sync |
| `windows-powershell` | Windows-safe paths and PowerShell commands |
| `release-notes` | Turn completed work into changelog entries |
| `refactor-planner` | Plan a safe multi-step refactor |

Catalog installs write a normal `SKILL.md` plus `.tagcode-skill.json` with
`sourceType: content`; the files are yours to edit afterwards. Reinstalling
replaces the local copy, so review local edits before doing it. All built-in
skills are validated by the same `validateSkillDirectory` path as external
skills and are covered by tests.

## Creating skills

```text
/skills create from-description "A skill for our design system"
/skills create from-project "Our FastAPI conventions"
/skills create from-session "Capture the workflow we just used"
/skills create "A skill for this project"
```

- `from-description` sends only the description.
- `from-project` includes the detected project summary and instruction files.
- `from-session` includes the recent conversation.
- No selector includes all available context.

The active model generates `SKILL.md`; TagCode validates it, retries once with
the validation errors, and installs it only if valid. Existing skills are never
silently overwritten (install fails unless `--force` is used from the CLI).

## Installation sources

- Local directory (`installFromLocal`) — copied, excluding `.git`, `node_modules`
  and TagCode install records.
- Git URL (`installFromGit`) — shallow clone, then install; accepts `ref`.
- Generated content (`installFromContent`) — used by `/skills create` and the
  desktop catalog install.
- Registry search only lists entries; install from the returned URL.

Each install writes `.tagcode-skill.json` with source, source type, install date
and version. Duplicate names are rejected unless forcing.

## Selection and context

`SkillManager.selectForTask()` scores skill names, descriptions, tags and
instructions against task terms, activates the best matches up to `maxActive`,
and exposes their instructions through the `skills` tool context. The full skill
index is available through `/skills index`; active instructions are capped.

## Registry format

`skills.registryUrl` should return JSON with a list of skills. The installer
accepts entries with `name`, `description`, `url`, optional `version` and `tags`.
Search is a convenience; review a skill before installing it.

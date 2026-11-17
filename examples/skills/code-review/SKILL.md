---
name: code-review
description: Review a change for correctness, security and project conventions. Use when asked to review code, a diff, or a pull request.
version: 1.0.0
tags: [review, quality]
---

# Code review

## When to use

Use this skill when the user asks for a review, a second opinion on a change, or
a risk assessment before merging.

## Procedure

1. Read the diff and the surrounding files, not just changed lines.
2. Check correctness: edge cases, error handling, cancellation and resource
   cleanup.
3. Check security: untrusted input, path handling, command execution, secret
   exposure, permission bypasses.
4. Check compatibility: public API changes, config/schema changes, Windows path
   behavior.
5. Check tests: do they cover the changed behavior and failure paths?
6. Report findings by severity with file and line references.
7. Do not modify files unless the user asks for fixes.

## Verification checklist

- Every finding includes a concrete location and a suggested direction.
- No invented issues: uncertain items are labeled as questions.
- The summary states what was reviewed and what was not.

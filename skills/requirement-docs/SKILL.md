---
name: requirement-docs
description: Unified spec for technical docs — requirements analysis, PRD, design, architecture, API design, tech plan, dev plan. Trigger before drafting or reorganizing any such doc; archive to docs/requirements-and-design/ with unified naming. English by default.
---

<!-- [2026-09-05]-[default output to English unless project rules/user explicitly request Chinese; generic examples]-[generated docs follow this default] -->
# Requirements & Design Doc Spec

Goal: centralized archiving, unified naming, consistent structure; understand existing code before proposing solutions.

Language: **English by default** (keep technical terms as-is). Use the project's configured language when the project's rules (AGENTS.md etc.) explicitly specify one, or when the user explicitly requests it.

## 1. Flow (every time)

1. Locate repo root, `mkdir -p docs/requirements-and-design/` (reuse the repo's existing archive dir if present); scan existing files to avoid name clashes and style drift.
2. Name as `yyyy-mm-dd-<module>-<type>.md`: today's date; module in kebab-case; type word in the doc's language — `requirements` / `PRD` / `design` / `architecture` / `api-design` / `tech-plan` / `dev-plan` (Chinese docs: 需求分析/PRD/设计/架构设计/接口设计/技术方案/开发计划).
   E.g. `docs/requirements-and-design/2026-09-05-config-loader-design.md`
3. Research first: read related code, `docs/`, `README`, `AGENTS.md`, key entities/services before writing.
4. Read `references/templates.md` (mandatory) to pick a skeleton; it defines structure only — render section titles and content in the output language. Self-check after writing (date, type word, section style, [Decided]/[Pending] markers, appendix), then report the file path to the user.

## 2. Core principles (legacy-system methodology)

1. **Evidence-backed current-state analysis**: trace call chains from entry points (Controller/API/CLI) to core logic with `file:line`; list reusable assets and reference implementations; call out existing pitfalls (swallowed exceptions, hardcoding, etc.). No empty "the system currently has X" statements.
2. **Current state → gaps → solution**: current-state analysis first, then a gap table (numbered D1/D2…, current vs required); the solution references gap IDs point by point.
3. **Honest [Decided]/[Pending] split** (Chinese: 【已定】/【待定】): confirmed decisions in a quote block at the top with confirmation dates; open questions in their own section, each with a recommended lean; every risk carries a mitigation. Never present pending as decided.
4. **Field-level clarity & appendix**: for key fields state exactly which entity/field they come from; expand ambiguous spots with a comparison and a recommendation; end with a file:line quick-reference table.

## 3. Writing rules

1. Wrap code, paths, field names in backticks.
2. Prefer mermaid or indented code blocks for call chains/sequences/flows; no external images.
3. Give reasons for decisions, not just conclusions.
4. When citing `file:line`, include the method name/context to survive line drift.

# AGENTS.md

Repository rules. A nested `AGENTS.md` may override these rules for its subtree.

## Boundaries

- **Server**: registers adapters, exposes capabilities, validates and persists cases, and enqueues runs. It does not interpret actors or touch real resources.
- **Worker**: fixed in-process thread. One worker executes one run at a time.
- **Adapter**: declares typed leaf capabilities. Each run owns its own session, which interprets actors, resources, and execution semantics.
- Shared packages depend on `@tp/contract` and stay decoupled through the registry, run queue, and contract types. Logs use `@tp/log`; metrics use `@tp/metrics`.
- **MCP**: independent stdio process. It depends on `@tp/contract` and calls a running server over HTTP. It is not embedded in the server.
- Product-specific concepts stay out of the platform core.
- Behavior tree execution follows BT.CPP v4 semantics. `ReactiveSequence`, `ReactiveFallback`, and `Repeat` / `RetryUntilSuccessful` with `-1` are allowed.
- A run may stay `RUNNING`; only cancellation halts the tree and releases worker/session resources.

## Changes

- Contract: `packages/contract/`; log: `packages/log/`; metrics: `packages/metrics/`; server: `packages/server/`; web: `packages/web/`; MCP: `packages/mcp/`; adapters: `packages/adapters/<name>/`; cross-package tests: `test/`.
- Do not edit `node_modules/`, `dist/`, `data/`, or `.codegraph/`.
- TypeScript is strict ESM with explicit `.ts` imports. API inputs use `zod`; domain types reuse `@tp/contract`.
- Keep changes surgical. Do not do unrelated refactors, formatting, or file moves.
- UI identity lives in `DESIGN.md`; implementation lives in `packages/web/src/styles.css`.
- Behavior changes need focused `node:test` coverage.
- The project is unreleased. Do not add legacy field aliases, migrate-on-read paths, compatibility defaults, or swallowed validation errors.

## Verification

- Docs: `git diff --check`; commands, ports, and paths must match source.
- Code: `npm run format:check`, `npm run lint`, `npm run typecheck`, and relevant tests. Before release or broad changes, run `npm test`.
- If the environment cannot run the full suite, run the closest checks and state what was not verified.

## Git

- Use Conventional Commits. One commit should cover one logical change.
- Do not commit secrets, generated build output, runtime data, or unrelated files.
- Do not push directly to `main`; use a feature branch and a GitHub pull request.
- Rebase feature branches on `origin/main` before pushing when practical. Use `--force-with-lease` only for your feature branch after a rebase.

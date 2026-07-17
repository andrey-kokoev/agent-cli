# Repository Guidelines

## Project Structure & Module Organization

This package is `@narada2/agent-cli`, an ESM Node CLI. Client/projection code lives in `src/`, with the main entry in `src/agent-cli.mjs` and focused modules such as `nars-attach-client.mjs`, `projected-terminal.mjs`, `terminal-rendering.mjs`, and `terminal-style.mjs`. Runtime-owned provider execution and MCP hosting belong to `@narada2/agent-runtime-server`, `@narada2/nars-provider-runtime`, and `@narada2/nars-capability-gateway`. `@narada2/carrier-runtime` is only a stateless turn adapter and is not a client dependency. CLI executables are in `bin/`. Tests are colocated in `src/*.test.mjs`. Documentation lives in `README.md`. Workspace dependency wiring is in `pnpm-workspace.yaml`, and package exports/scripts are in `package.json`.

## NARS Client Boundary

`agent-cli` is a NARS client/projection peer to `agent-tui` and future web clients. It should attach to existing NARS sessions via the NARS protocol, subscribe to events, render them for a terminal, and convert operator input into protocol frames. It must not regain ownership of session runtime, MCP fabric hosting, provider subprocesses, status/health construction, event persistence, or lifecycle dispatch. Those responsibilities belong under `@narada2/agent-runtime-server` and related Narada runtime/carrier packages. Do not add `--server`, `--carrier-server-substrate`, `agent-runtime-server` bin shims, or runtime-server compatibility exports back to this package.

## Build, Test, and Development Commands

- `pnpm test`: runs all Node and PTY tests via `node --test src/*.test.mjs src/agent-cli-pty-e2e.mjs`.
- `node --test src/agent-cli.test.mjs`: runs one focused test file while iterating.
- `pnpm typecheck`: runs TypeScript checking over JS entry points without emitting files.
- `pnpm run verify:native-codex-mcp`: verifies local Codex MCP discovery and native integration.
- `node --check src/<file>.mjs`: fast syntax check for a touched module.

## Coding Style & Naming Conventions

Use ESM imports/exports and `.mjs` files. Keep modules focused around terminal-client concerns: NARS attachment, projected terminal rendering, CLI options, and read-only session utilities. Provider adapters, MCP hosting, and carrier runtime behavior belong in Narada runtime packages, not this package. Prefer descriptive camelCase for functions and variables, PascalCase only for classes, and uppercase constants for process-wide configuration. Match the existing two-space indentation, semicolon style, and direct `node:` built-in imports. Keep comments sparse and useful.

## Testing Guidelines

Tests use Node's built-in test runner plus `node:assert/strict`. Name test files `*.test.mjs` and colocate them under `src/`. Add targeted regression coverage for terminal input projection, event rendering, attachment, and session-file utilities. Provider, MCP, and server-mode tests belong in their runtime-owner packages. For broad changes, run `pnpm test`; for narrow changes, run the touched test file plus `node --check` on edited modules.

## Commit & Pull Request Guidelines

Recent history uses short imperative subjects, for example `Split agent CLI runtime modules`, `Clear transient thinking lines`, and `Stream Codex output and wrap routed rows`. Keep commits thematic and avoid mixing unrelated refactors with behavior fixes. Pull requests should describe the user-visible behavior, list validation commands run, and call out any MCP, provider, terminal rendering, or environment-variable impact.

## Security & Configuration Tips

Do not commit API keys or local secrets. The client must not read, project, or forward provider credentials. Tests should restore any process environment they mutate.

# Repository Guidelines

## Project Structure & Module Organization

This package is `@narada2/agent-cli`, an ESM Node CLI. Runtime code lives in `src/`, with the main entry in `src/agent-cli.mjs` and focused modules such as `provider-adapters.mjs`, `mcp-runtime.mjs`, `projected-terminal.mjs`, `terminal-rendering.mjs`, and `terminal-style.mjs`. CLI executables are in `bin/`. Tests are colocated in `src/*.test.mjs`. Documentation lives in `README.md` and `docs/`; PowerShell wrapper templates live in `templates/`. Workspace dependency wiring is in `pnpm-workspace.yaml`, and package exports/scripts are in `package.json`.

## Build, Test, and Development Commands

- `pnpm test`: runs all Node tests via `node --test src/*.test.mjs`.
- `node --test src/agent-cli.test.mjs`: runs one focused test file while iterating.
- `pnpm typecheck`: runs TypeScript checking over JS entry points without emitting files.
- `pnpm run verify:native-codex-mcp`: verifies local Codex MCP discovery and native integration.
- `node --check src/<file>.mjs`: fast syntax check for a touched module.

## Coding Style & Naming Conventions

Use ESM imports/exports and `.mjs` files. Keep modules focused around runtime concerns: provider adapters, MCP runtime, terminal rendering, CLI options, and session behavior. Prefer descriptive camelCase for functions and variables, PascalCase only for classes, and uppercase constants for process-wide configuration. Match the existing two-space indentation, semicolon style, and direct `node:` built-in imports. Keep comments sparse and useful.

## Testing Guidelines

Tests use Node's built-in test runner plus `node:assert/strict`. Name test files `*.test.mjs` and colocate them under `src/`. Add targeted regression coverage near related assertions, especially for terminal output, provider parsing, MCP behavior, and server-mode events. For broad changes, run `pnpm test`; for narrow changes, run the touched test file plus `node --check` on edited modules.

## Commit & Pull Request Guidelines

Recent history uses short imperative subjects, for example `Split agent CLI runtime modules`, `Clear transient thinking lines`, and `Stream Codex output and wrap routed rows`. Keep commits thematic and avoid mixing unrelated refactors with behavior fixes. Pull requests should describe the user-visible behavior, list validation commands run, and call out any MCP, provider, terminal rendering, or environment-variable impact.

## Security & Configuration Tips

Do not commit API keys or local secrets. Provider behavior is controlled through environment variables such as `NARADA_INTELLIGENCE_PROVIDER`, `OPENAI_API_KEY`, `KIMI_API_KEY`, and `NARADA_CODEX_EXEC_PREFIX_ARGS`; tests should restore any process environment they mutate.

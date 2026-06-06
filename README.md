# @narada2/agent-cli

Standalone repository for the Narada agent CLI and agent runtime server package.

Package name remains `@narada2/agent-cli`.

This local extraction currently links its Narada carrier dependencies from `../narada/packages/*` through `pnpm-workspace.yaml`.

## Commands

```powershell
pnpm test
pnpm typecheck
pnpm run verify:native-codex-mcp
```

## MCP tool discovery

Agent CLI exposes discovered MCP tools in three places:

- `/help` lists the interactive commands available in a running session.
- `/tools [filter]` shows discovered MCP tools, their owning server, and compact input schemas.
- Runtime status events include a structured `mcp_tools` array for programmatic callers.

Nested Codex runs receive Narada MCP tools as native MCP tools by default. Set
`NARADA_CODEX_NATIVE_MCP_TOOLS=false` to use the JSON handoff fallback path instead.

Use `pnpm run verify:native-codex-mcp` to verify the local Codex installation can discover
and call an injected fixture MCP tool through native `codex exec --json` events.

## MCP troubleshooting

If `/tools` shows no tools, check the configured MCP servers for the session and use
`/status` to confirm the runtime sees the expected MCP server and tool counts.

If `pnpm run verify:native-codex-mcp` fails, the local Codex installation did not complete
a native MCP tool call against the fixture server. Check that `codex exec --json` is on
the expected Codex version and that local MCP server processes can be spawned from the
current shell.

If native MCP discovery is blocking work, set `NARADA_CODEX_NATIVE_MCP_TOOLS=false` before
starting the session. Nested Codex runs will use the JSON handoff fallback instead.

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

- `/help` lists the slash commands available in a running server-backed session.
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

## Carrier host commands

In a server-backed session, prefix an operator input line with `!` to execute a command on
the carrier host instead of sending it to the provider, for example `! git status`. Host
commands emit carrier session evidence and do not create provider turns. Set
`NARADA_AGENT_CLI_HOST_COMMANDS=false` to disable this execution path.

## Carrier session goal

Use `/goal` to show the current carrier session goal, `/goal <text>` to set it,
`/goal pause` or `/goal resume` to control it, and `/goal clear` to clear it. The
CLI initializes this session-local value as active from `NARADA_AGENT_CLI_GOAL`,
`NARADA_CARRIER_GOAL`, or `NARADA_GOAL` when present.

## Conversation observers

Observer interjections can arrive through the carrier control input channel as labeled
`source_kind: "agent"` events with observer metadata. The CLI renders operator-visible
observer notes distinctly and routes agent-visible notes through the normal provider-turn
path, queueing them while another turn is active.

Use `/observers` to inspect observer posture. Use `/observer mute` and `/observer unmute`
to suppress or restore visible observer interjections for the current session.

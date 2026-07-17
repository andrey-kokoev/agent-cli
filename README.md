# @narada2/agent-cli

Terminal client and projection for an existing Narada Agent Runtime Server session.

`agent-cli` owns:

- WebSocket attachment and event replay;
- terminal rendering;
- conversion of operator input into the narrow session-core control contract;
- explicit session-file inspection and synchronization utilities.

It does not execute providers, start MCP servers, supervise runtime processes, or own session lifecycle state. Those responsibilities belong to Narada proper.

## Commands

```powershell
pnpm test
pnpm run test:e2e:pty
pnpm typecheck
```

`pnpm test` includes the PTY-backed suite; `pnpm run test:e2e:pty` remains the focused PTY command.

Attach to a running session:

```powershell
narada-agent-cli --attach ws://127.0.0.1:PORT/events
```

The terminal emits only the session-core controls supported by the runtime server:

- `session.submit`
- `session.health`
- `session.cancel`
- `session.recovery`
- `session.close`
- `session.events.subscribe`

Provider selection, credentials, MCP diagnostics, and capability inventory are runtime projections. Inspect them through the runtime health and event surfaces rather than starting provider or MCP machinery from this package.

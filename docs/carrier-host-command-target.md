# Carrier Host Command Target

## Intent

`agent-cli` should support operator-entered host commands using an exclamation-mark prefix:

```text
! <command>
```

A host command executes on the carrier host: the local machine and process environment where `agent-cli` is running. It is not a provider prompt, not an MCP tool call, and not a Narada authority mutation by itself.

The feature exists for carrier-local operations that an operator intentionally runs while inhabiting a session, such as inspecting the workspace, invoking project scripts, or running local diagnostics.

## Non-Goals

- Do not treat `!` input as model-visible conversation text.
- Do not silently grant task, inbox, publication, credential, or Narada mutation authority.
- Do not bypass existing approval or audit posture for effectful local execution.
- Do not reinterpret `!` as a shell escape inside provider output or observer input.
- Do not create a new durable command authority separate from the carrier host execution path.

## Input Semantics

An operator input line in a server-backed session is a host-command request when, after leading whitespace is ignored, it starts with `!` and has non-empty command text after the prefix.

Examples:

```text
! git status
! pnpm test
! dir
```

The following should not execute as host commands:

```text
!
!   
hello ! git status
```

Escaping literal operator text can be handled separately if needed. Until then, only prefix-position `!` has host-command meaning.

## Admission Boundary

Host-command handling should have an explicit classification step before execution. The classifier should produce at least:

- `is_host_command`
- `command_text`
- `admission_action`: `execute`, `reject`, or `prompt_for_approval`
- `admission_reason`
- `execution_surface`: `carrier_host_shell`
- `creates_provider_turn`: always `false`

The carrier may reject empty commands, unsupported shell syntax, disabled host execution posture, or commands that require approval when approval is unavailable.

## Execution Semantics

Execution runs in the carrier host context with:

- working directory equal to the current carrier workspace unless explicitly changed by future policy;
- inherited environment only after any existing carrier environment filtering is applied;
- bounded stdout/stderr capture;
- a terminal state of `completed`, `failed`, `rejected`, or `interrupted`;
- no provider dispatch and no session message appended as user conversation content.

The first implementation may execute through the same local process capabilities already available to `agent-cli`, but the behavior should be factored so admission, execution, rendering, and evidence are separately testable.

## Evidence

A host-command request should emit reconstructable session evidence. At minimum:

- `carrier_host_command_requested`
- `carrier_host_command_admitted` or `carrier_host_command_rejected`
- `carrier_host_command_started`
- `carrier_host_command_completed` or `carrier_host_command_failed`

Evidence should include:

- command id;
- command text or a redacted command summary if secrets are detected;
- working directory;
- exit code when available;
- terminal state;
- output reference or bounded inline output summary;
- timestamp fields consistent with existing carrier session events.

Large output should use payload refs instead of bloating session logs.

The first implementation stores large output under the carrier session directory and emits an
`mcp_payload:carrier_host_command_output:<command_id>@v1` ref with reader tool
`carrier_host_command_output_read`.

## Rendering

Interactive rendering should label host command execution distinctly from operator prompts, provider messages, MCP tool calls, and observer notes. The operator should be able to see:

- the admitted command;
- live or completed output, depending on implementation path;
- exit status;
- rejection or approval reason when not executed.

Runtime server JSONL mode should expose structured events rather than terminal-only formatting.

## Relationship To Slash Commands

Slash commands are carrier-local control commands such as `/status`, `/tools`, and `/observer mute`.

Exclamation commands are carrier-host execution requests. They may have side effects on the host and therefore need admission and evidence.

The two command families should stay distinct in parser, classifier, event vocabulary, and tests.

## Test Targets

Implementation should add tests for:

- parsing `! <command>` without treating ordinary text containing `!` as execution;
- rejecting empty `!` input;
- no provider turn creation;
- command evidence sequence for admitted execution;
- bounded output capture or payload-ref behavior;
- failed command terminal state;
- disabled or approval-required host execution posture;
- interaction with existing slash commands and observer input.

## Initial Implementation Decisions

- Host execution is enabled by default for server-backed operator input and can be disabled with `NARADA_AGENT_CLI_HOST_COMMANDS=false`.
- Raw runtime-server JSONL frames do not accept host-command requests in the first implementation; terminal wrappers classify operator input before forwarding provider turns.
- Windows hosts execute through `%ComSpec%` or `cmd.exe` with `/d /s /c`; POSIX hosts execute through `$SHELL` or `/bin/sh` with `-lc`.
- Command allowlists and approval prompts are classifier states but are not wired to a runtime approval UI in the first implementation.
- Command redaction is not implemented in the first implementation; emitted evidence records `redaction_applied: false`.

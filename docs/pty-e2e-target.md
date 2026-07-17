# PTY-backed e2e target

The pipe-backed e2e suite proves that `agent-cli` attaches to a NARS event stream, submits control frames, receives runtime events, and renders the expected transcript. It does not prove interactive terminal semantics. The PTY-backed layer fills exactly that gap.

## Boundary

The PTY suite must launch the real CLI binary under a pseudo-terminal:

```text
node bin/narada-agent-cli.mjs --attach <fixture event stream url>
```

The test fixture owns the runtime side, using the same deterministic session-core runtime fixture shape as `src/agent-cli-e2e.test.mjs`. `agent-cli` remains only a NARS client/projection peer. The PTY suite must not add server mode, provider execution, MCP hosting, or lifecycle ownership to this package.

The test must observe both sides of the boundary:

- PTY screen bytes after ANSI/control-sequence normalization.
- NARS control frames and runtime events emitted by the fixture.

Passing on only one side is insufficient. A test that sees the correct frame but does not prove the operator saw the correct screen remains performative. A test that sees plausible screen text but does not prove the submitted frame remains performative.

## Harness

Use `node-pty` or an equivalent ConPTY-backed library on Windows and POSIX pty support on Unix. The dependency belongs in test/dev dependency scope only. The harness should expose:

- `spawnAgentCliPty({ endpoint, columns, rows, env })`
- `write(text)` for exact byte sequences
- `paste(text)` for bracketed paste: `\x1b[200~${text}\x1b[201~`
- `key(name)` for named keys mapped per platform where needed
- `screenText()` with ANSI cursor/control normalization
- `waitForScreen(pattern, label)`
- `waitForFrame(predicate, label)`
- `waitForEvent(predicate, label)`
- deterministic cleanup that kills the PTY process and closes the fixture runtime

The harness must fail closed. If a PTY dependency is unavailable, the test command should skip only under an explicit opt-in variable such as `NARADA_AGENT_CLI_PTY_E2E=skip`; otherwise absence of PTY support is a failed environment, not a green test.

## Test command

Run the PTY suite as part of the default `pnpm test` verification, and retain a focused command for iterating on PTY cases:

```json
"test:e2e:pty": "node --test src/agent-cli-pty-e2e.mjs"
```

CI can run it on at least Windows because the bug class is Windows Terminal/ConPTY-sensitive. Local focused validation may use `pnpm run test:e2e:pty`; broad validation uses `pnpm test`.

## Required cases

### Single-line paste remains editable

Input sequence:

1. Start fresh attached CLI.
2. Bracket-paste `"x"` without Enter.
3. Type ` plus y`.
4. Press Enter.

Assertions:

- No NARS submit frame before Enter.
- Draft screen contains `operator > "x" plus y` before Enter.
- Exactly one submit frame after Enter.
- Submitted content is exactly `"x" plus y`.
- Runtime emits exactly one `user_message` with that content.
- Screen renders one operator block and one assistant response.

This catches the failure where Ctrl+V of `"x"` submits immediately or unwraps into an unintended command/input.

### Multiline paste is one draft, not multiple turns

Input sequence:

1. Bracket-paste `line 1\nline 2\nline 3` without Enter.
2. Wait briefly for accidental submissions.
3. Press Enter.

Assertions:

- No submit frame appears before Enter.
- Draft screen shows one multiline operator draft with all three lines in order.
- After Enter, exactly one submit frame exists.
- Submitted content is exactly `line 1\nline 2\nline 3`.
- Runtime emits exactly one `user_message`, not three.
- Screen never contains known corruption shapes such as `line 3or > line 1`.

This catches multiline paste being split into multiple inputs and draft repaint corruption after async output.

### Slash-looking paste remains prose until Enter

Input sequence:

1. Bracket-paste `/health\nthis is copied prose, not a command sequence` without Enter.
2. Press Enter.

Assertions:

- No `session.health` frame before Enter.
- Exactly one `session.submit` frame after Enter.
- Submitted content is the full pasted multiline text.
- The fixture provider receives that text as a user message.

This catches pasted prose being interpreted as a slash-command sequence.

### Navigation keys edit the draft, not literal escape text

Input sequence:

1. Type `abc`.
2. Send Home.
3. Type `X`.
4. Send End.
5. Type `Y`.
6. Send Left.
7. Type `Z`.
8. Press Enter.

Assertions:

- Screen draft never contains literal fragments such as `[H`, `[F`, `[D`, `[1~`, or `[4~`.
- Submitted content reflects the edited draft exactly.
- Exactly one submit frame is emitted.

This catches regressions where Home inserts `[H` or cursor/navigation bytes leak into input.

### Ctrl+Arrow has an explicit contract

The test must encode the intended Ctrl+Arrow behavior after the implementation contract is chosen. The minimum acceptable target is:

- Ctrl+Left and Ctrl+Right do not insert escape text into the draft.
- They either move by word or are ignored as navigation.
- The resulting submitted content is deterministic and asserted exactly.

Leaving Ctrl+Arrow unasserted keeps the test layer performative for the known navigation bug class.

### Input during active model turn is steering, not post-turn surprise

Fixture behavior:

- First user input starts a turn that remains active until the test releases it.
- While active, the operator enters `steer this turn` and presses Enter.
- Then the fixture completes the active turn.

Assertions:

- The second input is sent while the fixture still reports an active turn.
- The frame/event uses the intended active-turn semantics once implemented, for example `conversation.steer` or `session.submit` with explicit `delivery_semantics: steering`.
- It is not delayed until after `turn_complete` as an ordinary next-turn input.
- The screen shows the operator that the input was accepted as steering, not as an ambiguous later message.

This test should fail against an implementation that queues operator input silently and only sends it after the model turn completes.

## Screen assertions

Normalize ANSI before matching, but do not reduce the transcript to loose substrings. Assertions should check:

- relevant line order
- exact occurrence counts for operator and assistant blocks
- absence of protocol JSON (`"method"`, `"params"`, event envelope schemas)
- absence of leaked escape fragments
- no duplicate assistant answer lines
- no prompt/draft concatenation corruption after async output

Timestamps may be normalized to `<timestamp>`. Session ids may be normalized only when they are not part of the behavior under test.

## Fixture assertions

Every PTY test must assert the runtime side as well:

- exact submitted frame count
- exact frame method and params
- exact `user_message` event count/content
- exact provider call count/transcript where a provider turn is expected
- exact tool invocation count/args where a tool turn is expected
- no `session_control_rejected` or `turn_failed` unless the test intentionally covers failure behavior

## Platform posture

The first implementation should run on Windows because the observed failures were ConPTY/Windows Terminal-sensitive. POSIX support is useful but not a substitute. If platform behavior differs, encode the difference in the key mapping layer, not in weaker assertions.

Do not use Windows Terminal tabs as the test driver. The PTY process is the test driver. Windows Terminal can remain a manual reproduction tool, but it is too hard to make single-tab launch behavior itself non-flaky and it is not needed to prove terminal byte semantics.

## Definition of done

The PTY-backed layer is complete when:

- `src/agent-cli-pty-e2e.test.mjs` or equivalent exists.
- `pnpm run test:e2e:pty` runs the real CLI binary under a PTY.
- The required cases above pass against the deterministic runtime fixture.
- At least one case fails if bracketed paste handling is disabled.
- At least one case fails if raw Home/End escape handling regresses to literal text insertion.
- The full `pnpm test` suite, including the pipe-backed and PTY-backed tests, still passes.


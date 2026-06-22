import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { createPayloadRef } from '@narada2/carrier-protocol';

export function classifyCarrierHostCommandInput(input, { enabled = true, approvalMode = 'execute' } = {}) {
  const rawInput = String(input ?? '');
  const trimmedStart = rawInput.trimStart();
  const isHostCommand = trimmedStart.startsWith('!');
  const commandText = isHostCommand ? trimmedStart.slice(1).trim() : '';
  const base = {
    is_host_command: isHostCommand,
    command_text: commandText,
    admission_action: 'none',
    admission_reason: null,
    execution_surface: 'carrier_host_shell',
    creates_provider_turn: false,
  };
  if (!isHostCommand) return base;
  if (!commandText) {
    return {
      ...base,
      admission_action: 'reject',
      admission_reason: 'empty_host_command',
    };
  }
  if (enabled !== true) {
    return {
      ...base,
      admission_action: 'reject',
      admission_reason: 'host_commands_disabled',
    };
  }
  if (approvalMode === 'prompt_for_approval') {
    return {
      ...base,
      admission_action: 'prompt_for_approval',
      admission_reason: 'approval_required',
    };
  }
  return {
    ...base,
    admission_action: 'execute',
    admission_reason: 'host_command_enabled',
  };
}

export async function executeCarrierHostCommand(admission, {
  commandId,
  cwd,
  env = process.env,
  appendSessionFn = () => {},
  carrierSessionEventEntryFn,
  outputDir,
  printResult = true,
  printHostCommandResultFn = () => {},
  spawnFn = nodeSpawn,
  now = () => new Date(),
  randomIdFn = defaultRandomId,
  writeDurableTextFileFn,
  outputInlineLimit = 8000,
  outputCaptureLimit = 128000,
} = {}) {
  if (!admission?.is_host_command) return { handled: false };
  if (typeof carrierSessionEventEntryFn !== 'function') throw new TypeError('carrierSessionEventEntryFn is required');
  if (typeof writeDurableTextFileFn !== 'function') throw new TypeError('writeDurableTextFileFn is required');
  const commandText = String(admission.command_text ?? '').trim();
  const resolvedCommandId = commandId ?? `host_command_${randomIdFn()}`;
  const requestedPayload = {
    command_id: resolvedCommandId,
    command_text: commandText,
    command_summary: summarizeHostCommandText(commandText),
    redaction_applied: false,
    working_directory: cwd,
    execution_surface: admission.execution_surface ?? 'carrier_host_shell',
  };
  appendSessionFn(carrierSessionEventEntryFn('carrier_host_command_requested', requestedPayload));
  if (admission.admission_action !== 'execute') {
    const terminalState = admission.admission_action === 'prompt_for_approval' ? 'rejected' : 'rejected';
    const result = {
      handled: true,
      command_id: resolvedCommandId,
      terminal_state: terminalState,
      admission_action: admission.admission_action,
      admission_reason: admission.admission_reason,
      exit_code: null,
      stdout: '',
      stderr: '',
      output_truncated: false,
      creates_provider_turn: false,
    };
    appendSessionFn(carrierSessionEventEntryFn('carrier_host_command_rejected', {
      ...requestedPayload,
      admission_action: admission.admission_action,
      admission_reason: admission.admission_reason,
      terminal_state: terminalState,
    }));
    if (printResult) printHostCommandResultFn({ ...result, command_text: commandText });
    return result;
  }

  appendSessionFn(carrierSessionEventEntryFn('carrier_host_command_admitted', {
    ...requestedPayload,
    admission_action: admission.admission_action,
    admission_reason: admission.admission_reason,
  }));
  const startedAt = now();
  appendSessionFn(carrierSessionEventEntryFn('carrier_host_command_started', {
    command_id: resolvedCommandId,
    started_at: startedAt.toISOString(),
  }));

  const shell = shellCommandForHost(commandText);
  return await new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let outputTruncated = false;
    let settled = false;
    const capture = (current, chunk) => {
      const next = current + String(chunk ?? '');
      if (next.length <= outputCaptureLimit) return next;
      outputTruncated = true;
      return next.slice(0, outputCaptureLimit);
    };
    const finish = ({ eventKind, exitCode = null, error = null }) => {
      if (settled) return;
      settled = true;
      const completedAt = now();
      const terminalState = error ? 'failed' : exitCode === 0 ? 'completed' : 'failed';
      const outputEvidence = hostCommandOutputEvidence({
        commandId: resolvedCommandId,
        stdout,
        stderr,
        outputTruncated,
        outputDir,
        outputInlineLimit,
        writeDurableTextFileFn,
      });
      const payload = {
        command_id: resolvedCommandId,
        command_text: commandText,
        command_summary: summarizeHostCommandText(commandText),
        redaction_applied: false,
        working_directory: cwd,
        exit_code: exitCode,
        terminal_state: terminalState,
        duration_ms: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        output_truncated: outputTruncated,
        ...outputEvidence,
        ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
      };
      appendSessionFn(carrierSessionEventEntryFn(eventKind, payload));
      const result = {
        handled: true,
        command_id: resolvedCommandId,
        command_text: commandText,
        terminal_state: terminalState,
        exit_code: exitCode,
        stdout,
        stderr,
        output_truncated: outputTruncated,
        output_ref: outputEvidence.output_ref ?? null,
        output_path: outputEvidence.output_path ?? null,
        creates_provider_turn: false,
      };
      if (printResult) printHostCommandResultFn(result);
      resolveResult(result);
    };

    let child;
    try {
      child = spawnFn(shell.command, shell.args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish({ eventKind: 'carrier_host_command_failed', error });
      return;
    }
    child.stdout?.on('data', (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = capture(stderr, chunk); });
    child.once('error', (error) => finish({ eventKind: 'carrier_host_command_failed', error }));
    child.once('close', (code) => {
      setImmediate(() => finish({
        eventKind: code === 0 ? 'carrier_host_command_completed' : 'carrier_host_command_failed',
        exitCode: typeof code === 'number' ? code : null,
      }));
    });
  });
}

export function shellCommandForHost(commandText) {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', commandText],
    };
  }
  return {
    command: process.env.SHELL || '/bin/sh',
    args: ['-lc', commandText],
  };
}

export function summarizeHostCommandText(commandText) {
  const text = String(commandText ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 240 ? `${text.slice(0, 239)}...` : text;
}

export function hostCommandOutputEvidence({
  commandId,
  stdout,
  stderr,
  outputTruncated,
  outputDir,
  outputInlineLimit = 8000,
  writeDurableTextFileFn,
}) {
  const output = { stdout, stderr };
  const inline = JSON.stringify(output).length <= outputInlineLimit && !outputTruncated;
  if (inline) {
    return {
      stdout,
      stderr,
    };
  }
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, `${commandId}.json`);
  writeDurableTextFileFn(outputPath, `${JSON.stringify({
    schema: 'narada.carrier.host_command_output.v1',
    command_id: commandId,
    output_truncated: outputTruncated,
    stdout,
    stderr,
  }, null, 2)}\n`, 'utf8');
  return {
    output_ref: createPayloadRef({
      payload_ref: `mcp_payload:carrier_host_command_output:${commandId}@v1`,
      reader_tool: 'carrier_host_command_output_read',
      summary: `carrier host command output stored at ${outputPath}`,
    }),
    output_path: outputPath,
  };
}

export function readCarrierHostCommandOutputRef(payloadRef, { outputDir } = {}) {
  const ref = typeof payloadRef === 'string' ? payloadRef : payloadRef?.payload_ref;
  const match = /^mcp_payload:carrier_host_command_output:([A-Za-z0-9_.:-]+)@v\d+$/.exec(String(ref ?? ''));
  if (!match) throw new Error(`invalid_carrier_host_command_output_ref:${String(ref ?? '')}`);
  const outputPath = join(outputDir, `${match[1]}.json`);
  return JSON.parse(readFileSync(outputPath, 'utf8'));
}

function defaultRandomId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

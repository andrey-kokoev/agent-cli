import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyCarrierHostCommandInput,
  hostCommandOutputEvidence,
  readCarrierHostCommandOutputRef,
  summarizeHostCommandText,
} from './host-command-runtime.mjs';

assert.equal(classifyCarrierHostCommandInput('hello').is_host_command, false);
assert.equal(classifyCarrierHostCommandInput('!   ').admission_reason, 'empty_host_command');
assert.equal(classifyCarrierHostCommandInput('!npm test', { enabled: false }).admission_reason, 'host_commands_disabled');
assert.equal(classifyCarrierHostCommandInput('!npm test').admission_action, 'execute');

assert.equal(summarizeHostCommandText(`run ${'x'.repeat(300)}`).length, 242);

const outputDir = mkdtempSync(join(tmpdir(), 'agent-cli-host-command-runtime-test-'));
try {
  const inline = hostCommandOutputEvidence({
    commandId: 'inline',
    stdout: 'ok',
    stderr: '',
    outputTruncated: false,
    outputDir,
    writeDurableTextFileFn: writeFileSync,
  });
  assert.deepEqual(inline, { stdout: 'ok', stderr: '' });

  const persisted = hostCommandOutputEvidence({
    commandId: 'persisted',
    stdout: 'x'.repeat(20),
    stderr: '',
    outputTruncated: false,
    outputDir,
    outputInlineLimit: 1,
    writeDurableTextFileFn: writeFileSync,
  });
  assert.equal(existsSync(persisted.output_path), true);
  assert.equal(persisted.output_ref.payload_ref, 'mcp_payload:carrier_host_command_output:persisted@v1');
  assert.equal(readCarrierHostCommandOutputRef(persisted.output_ref, { outputDir }).command_id, 'persisted');
  assert.equal(JSON.parse(readFileSync(persisted.output_path, 'utf8')).stdout, 'x'.repeat(20));
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConversationTurn } from './agent-cli.mjs';

test('delegated NARS turn executes read-only tools but refuses task mutation under read authority', async () => {
  const siteRoot = mkdtempSync(join(tmpdir(), 'narada-nars-read-authority-probe-'));
  const events = [];
  const sentTools = [];
  let providerCallCount = 0;

  try {
    const result = await runConversationTurn(
      [
        { role: 'system', content: 'You are a delegated NARS mutation probe.' },
        { role: 'user', content: 'Read context and then claim the disposable task.' },
      ],
      [
        {
          type: 'function',
          function: {
            name: 'fs_read_file',
            description: 'read-only fixture',
            parameters: { type: 'object', properties: {} },
          },
        },
        {
          type: 'function',
          function: {
            name: 'task_lifecycle_claim',
            description: 'mutating fixture',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      {
        fixture: {
          tools: [{ name: 'fs_read_file' }, { name: 'task_lifecycle_claim' }],
          registry_tools: {
            fs_read_file: {
              read_only: true,
              family: 'read_only_context',
              authority_owner: 'target_site_read_policy',
              source: 'surface_registry',
              reason: 'probe_read_authority',
            },
            task_lifecycle_claim: {
              read_only: false,
              family: 'task_lifecycle_mutation',
              authority_owner: 'task_governance_service',
              source: 'surface_registry',
              reason: 'probe_mutation_requires_write_authority',
            },
          },
          send: async (request) => {
            sentTools.push(request.params.name);
            return {
              result: {
                content: [{ text: JSON.stringify({ status: 'ok', output_ref: 'mcp_output:nars_probe_read' }) }],
              },
            };
          },
          config: {},
        },
      },
      null,
      {
        agentId: 'narada.probe.reader',
        carrierSessionId: 'nars-probe-read-authority',
        siteRoot,
        turn: { turnId: 'turn_nars_probe', interruptRequested: false },
        emit: (event, payload) => events.push({ event, ...payload }),
        callChatApiFn: async () => {
          providerCallCount += 1;
          if (providerCallCount === 1) {
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: 'Probing delegated tool boundaries.',
                  tool_calls: [
                    {
                      id: 'call_probe_read',
                      type: 'function',
                      function: { name: 'fs_read_file', arguments: '{"path":"README.md"}' },
                    },
                    {
                      id: 'call_probe_mutate',
                      type: 'function',
                      function: {
                        name: 'task_lifecycle_claim',
                        arguments: '{"task_number":1330,"body":"raw mutation payload must not persist"}',
                      },
                    },
                  ],
                },
              }],
            };
          }
          return { choices: [{ message: { role: 'assistant', content: 'Probe complete.' } }] };
        },
      },
    );

    assert.equal(result.terminal_state, 'completed');
    assert.deepEqual(sentTools, ['fs_read_file']);
    assert.equal(
      events.some((event) =>
        event.event === 'tool_result'
        && event.tool === 'fs_read_file'
        && event.status === 'ok'
        && event.output_ref === 'mcp_output:nars_probe_read'
      ),
      true,
    );

    const mutationCall = events.find((event) => event.event === 'tool_call' && event.tool === 'task_lifecycle_claim');
    assert.equal(mutationCall.decision, 'routed');
    assert.equal(mutationCall.raw_arguments_recorded, false);
    assert.equal('arguments' in mutationCall, false);

    const mutationResult = events.find((event) =>
      event.event === 'tool_result' && event.tool === 'task_lifecycle_claim'
    );
    assert.equal(mutationResult.status, 'admission_required');
    assert.equal(mutationResult.decision, 'routed');
    assert.equal(mutationResult.authority_owner, 'task_governance_service');
    assert.equal(mutationResult.carrier_mutation_admitted, false);

    const evidenceText = readFileSync(mutationResult.evidence_path, 'utf8');
    const evidence = JSON.parse(evidenceText);
    assert.equal(evidence.schema, 'narada.carrier_action_admission_decision.v0');
    assert.equal(evidence.request.requested_action.tool, 'task_lifecycle_claim');
    assert.equal(evidence.request.requested_action.classifier_source, 'surface_registry');
    assert.doesNotMatch(evidenceText, /raw mutation payload must not persist/);
  } finally {
    rmSync(siteRoot, { recursive: true, force: true });
  }
});

test('delegated NARS turn admits a safe disposable mutation under write authority', {
}, async () => {
  const siteRoot = mkdtempSync(join(tmpdir(), 'narada-nars-write-authority-probe-'));
  const events = [];
  const sentTools = [];
  let providerCallCount = 0;
  const delegatedAuthorityHandoff = {
    schema: 'narada.nars.delegated_authority_handoff.v1',
    crossing_regime: 'nars_runtime_server_to_carrier_substrate',
    parse_status: 'accepted',
    agent_id: 'narada.probe.writer',
    session_id: 'nars-probe-write-authority',
    authority_ref: 'task:1329',
    authority_mode: 'write',
    allowed_action_families: ['site_file_mutation', 'task_lifecycle_mutation', 'command'],
  };

  try {
    const result = await runConversationTurn(
      [
        { role: 'system', content: 'You are a delegated NARS write-authority probe.' },
        { role: 'user', content: 'Exercise read, file write, task claim, command execution, and a refused secret write.' },
      ],
      ['fs_read_file', 'write_file', 'task_lifecycle_claim', 'execute_command'].map((name) => ({
        type: 'function',
        function: {
          name,
          description: `${name} fixture`,
          parameters: { type: 'object', properties: {} },
        },
      })),
      {
        fixture: {
          tools: [
            { name: 'fs_read_file' },
            { name: 'write_file' },
            { name: 'task_lifecycle_claim' },
            { name: 'execute_command' },
          ],
          registry_tools: {
            fs_read_file: {
              read_only: true,
              family: 'read_only_context',
              authority_owner: 'target_site_read_policy',
              source: 'surface_registry',
              reason: 'probe_read_authority',
            },
            write_file: {
              read_only: false,
              family: 'site_file_mutation',
              authority_owner: 'target_site_file_authority',
              source: 'surface_registry',
              reason: 'probe_file_write_requires_delegated_authority',
            },
            task_lifecycle_claim: {
              read_only: false,
              family: 'task_lifecycle_mutation',
              authority_owner: 'task_governance_service',
              source: 'surface_registry',
              reason: 'probe_task_mutation_requires_delegated_authority',
            },
            execute_command: {
              read_only: false,
              family: 'command',
              authority_owner: 'command_execution_intent_service',
              source: 'surface_registry',
              reason: 'probe_command_requires_delegated_authority',
            },
          },
          send: async (request) => {
            sentTools.push(request.params.name);
            return {
              result: {
                content: [{ text: JSON.stringify({ status: 'executed', tool: request.params.name }) }],
              },
            };
          },
          config: {},
        },
      },
      null,
      {
        agentId: 'narada.probe.writer',
        carrierSessionId: 'nars-probe-write-authority',
        siteRoot,
        delegatedAuthorityHandoff,
        turn: { turnId: 'turn_nars_write_probe', interruptRequested: false },
        emit: (event, payload) => events.push({ event, ...payload }),
        callChatApiFn: async () => {
          providerCallCount += 1;
          if (providerCallCount === 1) {
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: 'Probing delegated write boundaries.',
                  tool_calls: [
                    {
                      id: 'call_probe_read',
                      type: 'function',
                      function: { name: 'fs_read_file', arguments: '{"path":"README.md"}' },
                    },
                    {
                      id: 'call_probe_write',
                      type: 'function',
                      function: { name: 'write_file', arguments: '{"path":"tmp.txt","content":"non-secret content"}' },
                    },
                    {
                      id: 'call_probe_task_claim',
                      type: 'function',
                      function: { name: 'task_lifecycle_claim', arguments: '{"task_number":1330}' },
                    },
                    {
                      id: 'call_probe_execute_command',
                      type: 'function',
                      function: { name: 'execute_command', arguments: '{"command":"echo ok"}' },
                    },
                    {
                      id: 'call_probe_secret_write',
                      type: 'function',
                      function: { name: 'write_file', arguments: '{"path":"secret.txt","content":"sk-testsecretvalue123456"}' },
                    },
                  ],
                },
              }],
            };
          }
          return { choices: [{ message: { role: 'assistant', content: 'Probe complete.' } }] };
        },
      },
    );

    assert.equal(result.terminal_state, 'completed');
    assert.deepEqual(sentTools, ['fs_read_file', 'write_file', 'task_lifecycle_claim', 'execute_command']);

    for (const tool of ['write_file', 'task_lifecycle_claim', 'execute_command']) {
      const toolCall = events.find((event) => event.event === 'tool_call' && event.tool === tool);
      assert.equal(toolCall.decision, 'delegated_mutation_admitted', tool);
      assert.equal(toolCall.carrier_mutation_admitted, true, tool);
      assert.equal('arguments' in toolCall, false, tool);

      const toolResult = events.find((event) => event.event === 'tool_result' && event.tool === tool);
      assert.equal(toolResult.status, 'ok', tool);
      assert.equal(toolResult.decision, 'delegated_mutation_admitted', tool);
      assert.equal(toolResult.carrier_mutation_admitted, true, tool);
      assert.equal(typeof toolResult.evidence_path, 'string', tool);
      const evidenceText = readFileSync(toolResult.evidence_path, 'utf8');
      const evidence = JSON.parse(evidenceText);
      assert.equal(evidence.decision, 'delegated_mutation_admitted', tool);
      assert.equal(evidence.carrier_mutation_admitted, true, tool);
      assert.equal(evidence.request.requested_action.delegated_authority.authority_ref, 'task:1329', tool);
      assert.doesNotMatch(evidenceText, /non-secret content|1330|echo ok/, tool);
    }

    const readResult = events.find((event) => event.event === 'tool_result' && event.tool === 'fs_read_file');
    assert.equal(readResult.status, 'ok');
    assert.equal(readResult.decision, 'read_only_admitted');
    assert.equal(readResult.carrier_mutation_admitted, false);

    const secretResult = events.find((event) =>
      event.event === 'tool_result' && event.tool === 'write_file' && event.status === 'admission_required'
    );
    assert.equal(secretResult.decision, 'refused');
    assert.equal(secretResult.reason, 'secret_or_credential_bearing_request');
    assert.equal(secretResult.carrier_mutation_admitted, false);
    const secretEvidenceText = readFileSync(secretResult.evidence_path, 'utf8');
    assert.doesNotMatch(secretEvidenceText, /sk-testsecretvalue123456/);
  } finally {
    rmSync(siteRoot, { recursive: true, force: true });
  }
});

import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DEFAULT_SITE_ROOT = resolve(process.env.NARADA_SITE_ROOT ?? process.cwd());
const DEFAULT_NARADA_DIR = join(DEFAULT_SITE_ROOT, '.narada');
const DEFAULT_SESSION = process.env.NARADA_CARRIER_SESSION_ID ?? process.env.NARADA_AGENT_CLI_SESSION ?? 'narada-architect';
const DEFAULT_IDENTITY = process.env.NARADA_AGENT_ID ?? 'narada.architect';
const HOST_COMMAND_OUTPUT_REF = String(process.env.NARADA_HOST_COMMAND_OUTPUT_REF ?? '').trim() || null;
const NARADA_DIR = DEFAULT_NARADA_DIR;
const SITE_ROOT = DEFAULT_SITE_ROOT;
const SESSION = DEFAULT_SESSION;
const IDENTITY = DEFAULT_IDENTITY;
const ENABLE_SESSION_FSYNC = parseBooleanEnv(
  process.env.NARADA_SESSION_FSYNC ?? process.env.NARADA_AGENT_CLI_SESSION_FSYNC,
  false,
);

function parseBooleanEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function formatKeyValueRows(record) {
  const entries = Object.entries(record);
  const width = entries.reduce((max, [key]) => Math.max(max, key.length), 0);
  return entries.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join('\n');
}

function createMcpPreflightWorkflowSnapshot({ session = SESSION, identity = IDENTITY } = {}) {
  return { handoffs: buildMcpPreflightHandoffs({ session, identity }) };
}

function buildMcpPreflightHandoffs({ session, identity = IDENTITY } = {}) {
  const normalizedSession = String(session ?? '').trim();
  const normalizedIdentity = String(identity ?? IDENTITY).trim() || IDENTITY;
  if (!normalizedSession) return {};
  const base = `narada-agent-cli --identity ${normalizedIdentity} --session ${normalizedSession}`;
  return {
    mcp_preflight_read: `${base} --mcp-preflight-read`,
    mcp_preflight_read_json: `${base} --mcp-preflight-read-json`,
    mcp_preflight_diagnostics: `${base} --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all`,
    mcp_preflight_diagnostics_json: `${base} --mcp-preflight-diagnostics-json --mcp-preflight-diagnostics-filter all`,
  };
}

function formatMcpStartupFailureSummary(failures = []) { return formatInventoryCounts(countByDiagnosticCode(failures)); }
function formatMcpRuntimeDiagnosticSummary(diagnostics = []) { return formatInventoryCounts(countByDiagnosticCode(diagnostics)); }
function countByDiagnosticCode(items = []) {
  const counts = {};
  for (const item of Array.isArray(items) ? items : []) {
    const code = item?.diagnostic_code === 'mcp_runtime_fault'
      ? (item?.tool_name ?? item?.code ?? 'unknown')
      : (item?.diagnostic_code ?? item?.code ?? 'unknown');
    const key = item?.server_name ? `${item.server_name}:${code}` : code;
    incrementInventoryCounter(counts, key);
  }
  return counts;
}
function summarizeSessionInventoryHostCommands(inventory = []) {
  const hostCommandSessions = inventory.filter((item) => Number(item?.host_command_event_count ?? 0) > 0);
  const hostCommandEventCounts = {};
  const hostCommandTerminalStateCounts = {};
  let outputRefCount = 0;
  for (const item of hostCommandSessions) {
    mergeInventoryCounts(hostCommandEventCounts, item?.host_command_event_counts ?? null);
    mergeInventoryCounts(hostCommandTerminalStateCounts, item?.host_command_terminal_state_counts ?? null);
    if (item?.last_host_command_output_ref) outputRefCount += 1;
  }
  return {
    host_command_session_count: hostCommandSessions.length,
    host_command_event_counts: hostCommandEventCounts,
    host_command_event_summary: formatInventoryCounts(hostCommandEventCounts),
    host_command_terminal_state_counts: hostCommandTerminalStateCounts,
    host_command_terminal_state_summary: formatInventoryCounts(hostCommandTerminalStateCounts),
    host_command_output_ref_count: outputRefCount,
    host_command_output_ref_summary: `${outputRefCount} with persisted output`,
    groups: {
      terminal_state: summarizeSessionInventoryGroupBy(hostCommandSessions, 'last_host_command_terminal_state', 'last_host_command_terminal_state'),
      recommended_action: summarizeSessionInventoryGroupBy(hostCommandSessions, 'recommended_action', 'recommended_action_display'),
    },
    workflow_groups: summarizeActionWorkflowGroups(hostCommandSessions),
    sessions: hostCommandSessions
      .slice()
      .sort((left, right) => Number(right?.host_command_event_count ?? 0) - Number(left?.host_command_event_count ?? 0)
        || String(right?.last_host_command_at ?? '').localeCompare(String(left?.last_host_command_at ?? ''))
        || String(left?.session ?? '').localeCompare(String(right?.session ?? ''))),
  };
}

function renderSessionInventoryHostCommands(sessions = []) {
  return sessions.map((item) => formatKeyValueRows({
    Session: item.session,
    Heartbeat: item.heartbeat_display,
    'Host command events': item.host_command_event_summary,
    'Host command states': item.host_command_terminal_state_summary,
    'Last host command': item.last_host_command_summary ?? 'none',
    'Last host command state': item.last_host_command_terminal_state ?? 'none',
    'Last host command at': item.last_host_command_at ?? 'unknown',
    'Host command output': item.last_host_command_output_ref ?? 'none',
    'Host command output review': item?.handoffs?.host_command_output_read ?? 'none',
    'Recommended action': item.recommended_action_display,
    'Recommended command': item.recommended_command ?? 'none',
    'Session read': item?.handoffs?.session_read ?? 'none',
    'Session recovery': item?.handoffs?.session_recovery ?? 'none',
    'Session diagnostics': item?.handoffs?.session_events_diagnostics ?? 'none',
  }));
}

function summarizeSessionInventoryOperations(inventory = []) {
  const operationSessions = inventory.filter((item) => Number(item?.operation_event_count ?? 0) > 0);
  const operationEventCounts = {};
  const directiveKindCounts = {};
  const directiveVisibilityCounts = {};
  const operationIdCounts = {};
  for (const item of operationSessions) {
    mergeInventoryCounts(operationEventCounts, item?.operation_event_counts ?? null);
    mergeInventoryCounts(directiveKindCounts, item?.directive_kind_counts ?? null);
    mergeInventoryCounts(directiveVisibilityCounts, item?.directive_visibility_counts ?? null);
    mergeInventoryCounts(operationIdCounts, item?.operation_id_counts ?? null);
  }
  return {
    operation_session_count: operationSessions.length,
    operation_event_counts: operationEventCounts,
    operation_event_summary: formatInventoryCounts(operationEventCounts),
    directive_kind_counts: directiveKindCounts,
    directive_kind_summary: formatInventoryCounts(directiveKindCounts),
    directive_visibility_counts: directiveVisibilityCounts,
    directive_visibility_summary: formatInventoryCounts(directiveVisibilityCounts),
    operation_id_counts: operationIdCounts,
    operation_id_summary: formatInventoryCounts(operationIdCounts),
    groups: {
      directive_kind: summarizeSessionInventoryGroupBy(operationSessions, 'last_directive_kind', 'last_directive_kind'),
      directive_visibility: summarizeSessionInventoryGroupBy(operationSessions, 'last_directive_visibility', 'last_directive_visibility'),
      recommended_action: summarizeSessionInventoryGroupBy(operationSessions, 'recommended_action', 'recommended_action_display'),
    },
    workflow_groups: summarizeActionWorkflowGroups(operationSessions),
    sessions: operationSessions
      .slice()
      .sort((left, right) => Number(right?.operation_event_count ?? 0) - Number(left?.operation_event_count ?? 0)
        || String(right?.last_operation_at ?? '').localeCompare(String(left?.last_operation_at ?? ''))
        || String(left?.session ?? '').localeCompare(String(right?.session ?? ''))),
  };
}

function renderSessionInventoryOperations(sessions = []) {
  return sessions.map((item) => formatKeyValueRows({
    Session: item.session,
    Heartbeat: item.heartbeat_display,
    'Operation events': item.operation_event_summary,
    'Directive kinds': item.directive_kind_summary,
    'Directive visibility': item.directive_visibility_summary,
    'Operation ids': item.operation_id_summary,
    'Last operation id': item.last_operation_id ?? 'none',
    'Last directive kind': item.last_directive_kind ?? 'none',
    'Last directive visibility': item.last_directive_visibility ?? 'none',
    'Last operation at': item.last_operation_at ?? 'unknown',
    'Recommended action': item.recommended_action_display,
    'Recommended command': item.recommended_command ?? 'none',
    'Session read': item?.handoffs?.session_read ?? 'none',
    'Session recovery': item?.handoffs?.session_recovery ?? 'none',
    'Session issues': item?.handoffs?.session_events_issues ?? 'none',
    'Session diagnostics': item?.handoffs?.session_events_diagnostics ?? 'none',
    'Session path': item.session_path,
  }));
}

function formatPersistedSessionEventLine(entry) {
  const timestamp = entry?.timestamp ?? entry?.occurred_at ?? entry?.payload?.occurred_at ?? entry?.payload?.created_at ?? 'unknown-time';
  const eventKind = entry?.event_kind ?? entry?.event ?? 'unknown-event';
  const terminalState = entry?.payload?.terminal_state ?? entry?.terminal_state ?? null;
  const issueCode = classifyPersistedSessionIssueCode(entry);
  const details = [];
  if (terminalState) details.push(`terminal=${terminalState}`);
  if (issueCode) details.push(`code=${issueCode}`);
  return `- ${timestamp} ${eventKind}${details.length > 0 ? ` [${details.join('; ')}]` : ''}`;
}

function formatPersistedSessionInventoryEventLine(entry) {
  const timestamp = entry?.timestamp ?? 'unknown-time';
  const session = entry?.session ?? 'unknown-session';
  const eventKind = entry?.event_kind ?? 'unknown-event';
  const terminalState = entry?.terminal_state ?? null;
  const issueCode = entry?.issue_code ?? null;
  const details = [];
  if (terminalState) details.push(`terminal=${terminalState}`);
  if (issueCode) details.push(`code=${issueCode}`);
  return `- ${session} ${timestamp} ${eventKind}${details.length > 0 ? ` [${details.join('; ')}]` : ''}`;
}

function buildPersistedSessionHandoffs({ session, identity = IDENTITY, eventCount = 20 } = {}) {
  const normalizedSession = String(session ?? '').trim();
  const normalizedIdentity = String(identity ?? IDENTITY).trim() || IDENTITY;
  if (!normalizedSession) return {};
  const base = `narada-agent-cli --identity ${normalizedIdentity} --session ${normalizedSession}`;
  return {
    session_operations: `${base} --session-operations`,
    session_operations_json: `${base} --session-operations-json`,
    session_read: `${base} --session-read`,
    session_read_json: `${base} --session-read-json`,
    session_recovery: `${base} --session-recovery`,
    session_recovery_json: `${base} --session-recovery-json`,
    session_events: `${base} --session-events --session-events-filter all --session-events-count ${eventCount}`,
    session_events_issues: `${base} --session-events --session-events-filter issues --session-events-count ${eventCount}`,
    session_events_diagnostics: `${base} --session-events --session-events-filter diagnostics --session-events-count ${eventCount}`,
  };
}

function buildPersistedHostCommandOutputHandoffs({ session, identity = IDENTITY, outputRef = null } = {}) {
  const normalizedSession = String(session ?? '').trim();
  const normalizedIdentity = String(identity ?? IDENTITY).trim() || IDENTITY;
  const normalizedOutputRef = String(outputRef ?? '').trim();
  if (!normalizedSession || !normalizedOutputRef) return {};
  const base = `narada-agent-cli --identity ${normalizedIdentity} --session ${normalizedSession}`;
  return {
    host_command_output_read: `${base} --host-command-output-read --host-command-output-ref ${normalizedOutputRef}`,
    host_command_output_read_json: `${base} --host-command-output-read-json --host-command-output-ref ${normalizedOutputRef}`,
  };
}

function summarizePersistedSessionRecommendedAction({
  operationalPosture = 'healthy',
  mcpOperationalState = 'unknown',
  requestPosture = 'clean',
  handoffs = {},
} = {}) {
  const recoveryCommand = handoffs.session_recovery ?? null;
  if (mcpOperationalState === 'runtime_faulted') {
    return {
      recommended_action: 'review_runtime_diagnostics',
      recommended_action_display: 'review runtime diagnostics',
      recommended_command: recoveryCommand,
    };
  }
  if (mcpOperationalState === 'startup_degraded') {
    return {
      recommended_action: 'review_startup_diagnostics',
      recommended_action_display: 'review startup diagnostics',
      recommended_command: recoveryCommand,
    };
  }
  if (requestPosture === 'runtime_failures') {
    return {
      recommended_action: 'review_request_issues',
      recommended_action_display: 'review request issues',
      recommended_command: recoveryCommand,
    };
  }
  if (requestPosture === 'invalid_control_traffic') {
    return {
      recommended_action: 'review_invalid_control_traffic',
      recommended_action_display: 'review invalid control traffic',
      recommended_command: recoveryCommand,
    };
  }
  if (requestPosture === 'closed_session_retries') {
    return {
      recommended_action: 'review_closed_session_retries',
      recommended_action_display: 'review closed session retries',
      recommended_command: recoveryCommand,
    };
  }
  if (operationalPosture === 'lifecycle_failed') {
    return {
      recommended_action: 'review_session_events',
      recommended_action_display: 'review session events',
      recommended_command: recoveryCommand,
    };
  }
  return {
    recommended_action: 'review_session_summary',
    recommended_action_display: 'review session summary',
    recommended_command: handoffs.session_read ?? null,
  };
}

function summarizePersistedSessionRecoveryPlan({
  operationalPosture = 'healthy',
  mcpOperationalState = 'unknown',
  requestPosture = 'clean',
  handoffs = {},
} = {}) {
  if (mcpOperationalState === 'runtime_faulted') {
    return {
      recovery_kind: 'diagnostic_review',
      recovery_kind_display: 'diagnostic review',
      recovery_primary_command: handoffs.session_events_diagnostics ?? null,
      recovery_followup_command: handoffs.session_read ?? null,
    };
  }
  if (mcpOperationalState === 'startup_degraded') {
    return {
      recovery_kind: 'startup_diagnostic_review',
      recovery_kind_display: 'startup diagnostic review',
      recovery_primary_command: handoffs.session_events_diagnostics ?? null,
      recovery_followup_command: handoffs.session_read ?? null,
    };
  }
  if (requestPosture === 'runtime_failures') {
    return {
      recovery_kind: 'issue_review',
      recovery_kind_display: 'issue review',
      recovery_primary_command: handoffs.session_events_issues ?? null,
      recovery_followup_command: handoffs.session_events ?? null,
    };
  }
  if (requestPosture === 'invalid_control_traffic') {
    return {
      recovery_kind: 'invalid_control_review',
      recovery_kind_display: 'invalid control review',
      recovery_primary_command: handoffs.session_events_issues ?? null,
      recovery_followup_command: handoffs.session_read ?? null,
    };
  }
  if (requestPosture === 'closed_session_retries') {
    return {
      recovery_kind: 'closed_session_review',
      recovery_kind_display: 'closed session review',
      recovery_primary_command: handoffs.session_events_issues ?? null,
      recovery_followup_command: handoffs.session_read ?? null,
    };
  }
  if (operationalPosture === 'lifecycle_failed') {
    return {
      recovery_kind: 'lifecycle_review',
      recovery_kind_display: 'lifecycle review',
      recovery_primary_command: handoffs.session_events ?? null,
      recovery_followup_command: handoffs.session_read ?? null,
    };
  }
  return {
    recovery_kind: 'no_recovery',
    recovery_kind_display: 'no recovery',
    recovery_primary_command: handoffs.session_read ?? null,
    recovery_followup_command: null,
  };
}

function summarizeActionWorkflowGroups(actions = []) {
  const groups = Object.create(null);
  for (const item of actions) {
    const key = String(item?.recommended_action ?? 'unknown');
    if (!groups[key]) {
      groups[key] = {
        display: item?.recommended_action_display ?? item?.recommended_action ?? 'unknown',
        recommended_command_counts: {},
        recovery_kind_counts: {},
        recovery_primary_counts: {},
        recovery_followup_counts: {},
        sessions: [],
      };
    }
    const group = groups[key];
    incrementInventoryCounter(group.recommended_command_counts, item?.recommended_command ?? 'none');
    incrementInventoryCounter(group.recovery_kind_counts, item?.recovery_kind ?? 'unknown');
    incrementInventoryCounter(group.recovery_primary_counts, item?.recovery_primary_command ?? 'none');
    incrementInventoryCounter(group.recovery_followup_counts, item?.recovery_followup_command ?? 'none');
    group.sessions.push({
      session: item?.session ?? 'unknown',
      display: item?.recovery_kind_display ?? item?.recovery_kind ?? 'unknown',
      heartbeat_at: item?.heartbeat_at ?? null,
    });
  }
  return Object.fromEntries(Object.entries(groups)
    .sort((left, right) => right[1].sessions.length - left[1].sessions.length || left[0].localeCompare(right[0]))
    .map(([key, group]) => [key, {
      display: group.display,
      recommended_command_counts: group.recommended_command_counts,
      recommended_command_summary: formatInventoryCounts(group.recommended_command_counts),
      recovery_kind_counts: group.recovery_kind_counts,
      recovery_kind_summary: formatInventoryCounts(group.recovery_kind_counts),
      recovery_primary_counts: group.recovery_primary_counts,
      recovery_primary_summary: formatInventoryCounts(group.recovery_primary_counts),
      recovery_followup_counts: group.recovery_followup_counts,
      recovery_followup_summary: formatInventoryCounts(group.recovery_followup_counts),
      sessions: group.sessions
        .sort((left, right) => String(right.heartbeat_at ?? '').localeCompare(String(left.heartbeat_at ?? '')) || left.session.localeCompare(right.session))
        .map(({ session, display }) => ({ session, display })),
    }]));
}

function summarizeSessionInventoryActions(inventory = []) {
  const recommendedActionCounts = {};
  const recommendedCommandCounts = {};
  const recoveryPrimaryCounts = {};
  const recoveryFollowupCounts = {};
  const actions = [];
  for (const item of inventory) {
    const recommendedAction = item?.recommended_action ?? 'review_session_summary';
    incrementInventoryCounter(recommendedActionCounts, recommendedAction);
    incrementInventoryCounter(recommendedCommandCounts, item?.recommended_command ?? 'none');
    incrementInventoryCounter(recoveryPrimaryCounts, item?.recovery_primary_command ?? 'none');
    incrementInventoryCounter(recoveryFollowupCounts, item?.recovery_followup_command ?? 'none');
    actions.push(item);
  }
  return {
    recommended_action_counts: recommendedActionCounts,
    recommended_action_summary: formatInventoryCounts(recommendedActionCounts),
    recommended_command_counts: recommendedCommandCounts,
    recommended_command_summary: formatInventoryCounts(recommendedCommandCounts),
    recovery_primary_counts: recoveryPrimaryCounts,
    recovery_primary_summary: formatInventoryCounts(recoveryPrimaryCounts),
    recovery_followup_counts: recoveryFollowupCounts,
    recovery_followup_summary: formatInventoryCounts(recoveryFollowupCounts),
    workflow_groups: summarizeActionWorkflowGroups(actions),
    action_count: actions.length,
    actions,
  };
}

function summarizeSessionInventoryRecoveryQueue(inventory = []) {
  const recoveryActions = inventory.filter((item) => item?.recommended_action !== 'review_session_summary');
  const recommendedActionCounts = {};
  const recoveryKindCounts = {};
  const recoveryPrimaryCounts = {};
  const recoveryFollowupCounts = {};
  for (const item of recoveryActions) {
    incrementInventoryCounter(recommendedActionCounts, item?.recommended_action ?? 'unknown');
    incrementInventoryCounter(recoveryKindCounts, item?.recovery_kind ?? 'unknown');
    incrementInventoryCounter(recoveryPrimaryCounts, item?.recovery_primary_command ?? 'none');
    incrementInventoryCounter(recoveryFollowupCounts, item?.recovery_followup_command ?? 'none');
  }
  return {
    recovery_count: recoveryActions.length,
    recommended_action_counts: recommendedActionCounts,
    recommended_action_summary: formatInventoryCounts(recommendedActionCounts),
    recovery_kind_counts: recoveryKindCounts,
    recovery_kind_summary: formatInventoryCounts(recoveryKindCounts),
    recovery_primary_counts: recoveryPrimaryCounts,
    recovery_primary_summary: formatInventoryCounts(recoveryPrimaryCounts),
    recovery_followup_counts: recoveryFollowupCounts,
    recovery_followup_summary: formatInventoryCounts(recoveryFollowupCounts),
    groups: summarizeSessionInventoryGroupBy(recoveryActions, 'recommended_action', 'recommended_action_display'),
    workflow_groups: summarizeActionWorkflowGroups(recoveryActions),
    actions: recoveryActions,
  };
}

function renderSessionInventoryActions(actions = []) {
  return actions.map((item) => formatKeyValueRows({
    Session: item.session,
    Heartbeat: item.heartbeat_display,
    'Operational posture': item.operational_posture_display,
    'MCP state': item.mcp_operational_state,
    'Request posture': item.request_posture_display,
    'Recommended action': item.recommended_action_display,
    'Recommended command': item.recommended_command ?? 'none',
    'Recovery kind': item.recovery_kind_display ?? 'none',
    'Recovery primary': item.recovery_primary_command ?? 'none',
    'Recovery followup': item.recovery_followup_command ?? 'none',
    'Session read': item?.handoffs?.session_read ?? 'none',
    'Session recovery': item?.handoffs?.session_recovery ?? 'none',
    'Session issues': item?.handoffs?.session_events_issues ?? 'none',
    'Session diagnostics': item?.handoffs?.session_events_diagnostics ?? 'none',
    'Host command output review': item?.handoffs?.host_command_output_read ?? 'none',
  }));
}

function renderSessionInventoryWorkflowGroups(groups = {}, { heading = 'Workflow groups' } = {}) {
  const sections = [];
  for (const [groupKey, group] of Object.entries(groups)) {
    const sessions = Array.isArray(group?.sessions) ? group.sessions : [];
    const lines = [`${heading}: ${groupKey} (${sessions.length})`];
    if (group?.recommended_command_summary) lines.push(`Recommended commands: ${group.recommended_command_summary}`);
    if (group?.recovery_kind_summary) lines.push(`Recovery kinds: ${group.recovery_kind_summary}`);
    if (group?.recovery_primary_summary) lines.push(`Primary commands: ${group.recovery_primary_summary}`);
    if (group?.recovery_followup_summary) lines.push(`Followup commands: ${group.recovery_followup_summary}`);
    for (const entry of sessions.slice(0, 5)) {
      lines.push(`- ${entry.session} ${entry.display ?? groupKey}`);
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

function renderSessionInventoryEventGroups(groups = {}) {
  const sections = [];
  for (const [groupKey, buckets] of Object.entries(groups)) {
    const lines = [`Event groups: ${groupKey}`];
    for (const [bucketKey, entries] of Object.entries(buckets)) {
      lines.push(`- ${bucketKey} (${entries.length})`);
      for (const entry of entries.slice(0, 5)) {
        lines.push(`  ${formatPersistedSessionInventoryEventLine(entry)}`);
      }
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

function summarizeSessionInventoryGroups(inventory = []) {
  return {
    operational_posture: summarizeSessionInventoryGroupBy(inventory, 'operational_posture', 'operational_posture_display'),
    request_posture: summarizeSessionInventoryGroupBy(inventory, 'request_posture', 'request_posture_display'),
    mcp_state: summarizeSessionInventoryGroupBy(inventory, 'mcp_operational_state', 'mcp_operational_state'),
    heartbeat_status: summarizeSessionInventoryGroupBy(inventory, 'heartbeat_status', 'heartbeat_display'),
  };
}

function summarizeSessionInventoryGroupBy(inventory = [], keyField, displayField) {
  const groups = Object.create(null);
  for (const item of inventory) {
    const key = String(item?.[keyField] ?? 'unknown');
    if (!groups[key]) groups[key] = [];
    groups[key].push({
      session: item.session,
      display: item?.[displayField] ?? item?.[keyField] ?? 'unknown',
      heartbeat_at: item?.heartbeat_at ?? null,
    });
  }
  return Object.fromEntries(Object.entries(groups)
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .map(([key, entries]) => [key, entries
      .sort((left, right) => String(right.heartbeat_at ?? '').localeCompare(String(left.heartbeat_at ?? '')) || left.session.localeCompare(right.session))
      .map(({ session, display }) => ({ session, display }))]));
}

function renderSessionInventoryGroups(groups = {}) {
  const sections = [];
  for (const [groupKey, buckets] of Object.entries(groups)) {
    const lines = [`Groups: ${groupKey}`];
    for (const [bucketKey, entries] of Object.entries(buckets)) {
      lines.push(`- ${bucketKey} (${entries.length})`);
      for (const entry of entries.slice(0, 5)) {
        lines.push(`  - ${entry.session}: ${entry.display}`);
      }
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

async function runSessionInventory({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false, filterKey = null, filterValue = null } = {}) {
  const inventory = readSessionInventory({ siteRoot, naradaDir });
  const normalizedFilterKey = normalizeSessionInventoryFilterKey(filterKey);
  const normalizedFilterValue = normalizeSessionInventoryFilterValue(filterValue);
  const filteredInventory = filterSessionInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const inventoryRollup = summarizeSessionInventoryRollup(inventory);
  const filteredInventoryRollup = summarizeSessionInventoryRollup(filteredInventory);
  const inventoryGroups = summarizeSessionInventoryGroups(filteredInventory);
  const actionQueue = summarizeSessionInventoryActions(filteredInventory);
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_inventory.v1',
      site_root: siteRoot,
      carrier_session_count: filteredInventory.length,
      total_carrier_session_count: inventory.length,
      inventory_filter: filterLabel,
      summary: {
        ...filteredInventoryRollup,
        recommended_action_counts: actionQueue.recommended_action_counts,
        recommended_action_summary: actionQueue.recommended_action_summary,
        recommended_command_counts: actionQueue.recommended_command_counts,
        recommended_command_summary: actionQueue.recommended_command_summary,
        recovery_primary_counts: actionQueue.recovery_primary_counts,
        recovery_primary_summary: actionQueue.recovery_primary_summary,
        recovery_followup_counts: actionQueue.recovery_followup_counts,
        recovery_followup_summary: actionQueue.recovery_followup_summary,
      },
      groups: inventoryGroups,
      workflow_groups: actionQueue.workflow_groups,
      sessions: filteredInventory,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Inventory filter': filterLabel, 'Matched sessions': filteredInventory.length, 'Total sessions': inventory.length } : { 'Carrier sessions': filteredInventory.length }),
    'Heartbeat states': filteredInventoryRollup.heartbeat_status_summary,
    'Operational posture': filteredInventoryRollup.operational_posture_summary,
    'MCP states': filteredInventoryRollup.mcp_operational_state_summary,
    'Terminal states': filteredInventoryRollup.last_terminal_state_summary,
    'Lifecycle states': filteredInventoryRollup.last_lifecycle_state_summary,
    'Lifecycle outcomes': filteredInventoryRollup.lifecycle_outcome_summary,
    'Request posture': filteredInventoryRollup.request_posture_summary,
    'Request outcomes': filteredInventoryRollup.request_outcome_summary,
    'Request issues': filteredInventoryRollup.request_issue_summary,
    'Operation events': filteredInventoryRollup.operation_event_summary,
    'Operation ids': filteredInventoryRollup.operation_id_summary,
    'Host command states': filteredInventoryRollup.host_command_terminal_state_summary,
    'Recommended actions': actionQueue.recommended_action_summary,
    'Recommended commands': actionQueue.recommended_command_summary,
    'Recovery primary commands': actionQueue.recovery_primary_summary,
    'Recovery followups': actionQueue.recovery_followup_summary,
  };
  if (filteredInventory.length === 0) {
    summary.Status = 'no persisted carrier sessions';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary)];
  for (const item of filteredInventory) {
    blocks.push(formatKeyValueRows({
      Session: item.session,
      Heartbeat: item.heartbeat_display,
      'Operational posture': item.operational_posture_display,
      'MCP state': item.mcp_operational_state,
      'Request posture': item.request_posture_display,
      'MCP startup failures': item.mcp_startup_failure_summary,
      'MCP runtime faults': item.mcp_runtime_fault_summary,
      'Operation events': item.operation_event_summary,
      'Operation ids': item.operation_id_summary,
      'Host command states': item.host_command_terminal_state_summary,
      'Last host command': item.last_host_command_summary ?? 'none',
      'Last host command state': item.last_host_command_terminal_state ?? 'none',
      'Preflight artifact': item.mcp_preflight_artifact_path ?? 'none',
      'Preflight state': item.mcp_preflight_operational_state ?? 'none',
      'Preflight action': item.mcp_preflight_recommended_action_display ?? 'none',
      'Preflight command': item.mcp_preflight_recommended_command ?? 'none',
      'Preflight diagnostics': item?.mcp_preflight_handoffs?.mcp_preflight_diagnostics ?? 'none',
      'Recommended action': item.recommended_action_display,
      'Recommended command': item.recommended_command ?? 'none',
      'Session read': item?.handoffs?.session_read ?? 'none',
      'Session issues': item?.handoffs?.session_events_issues ?? 'none',
      'Session diagnostics': item?.handoffs?.session_events_diagnostics ?? 'none',
      'Host command output review': item?.handoffs?.host_command_output_read ?? 'none',
      'Session path': item.session_path,
    }));
  }
  blocks.push(renderSessionInventoryWorkflowGroups(actionQueue.workflow_groups, { heading: 'Inventory action groups' }));
  blocks.push(renderSessionInventoryGroups(inventoryGroups));
  console.log(blocks.join('\n\n'));
  return 0;
}

async function runSessionInventoryHostCommands({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false, filterKey = null, filterValue = null } = {}) {
  const inventory = readSessionInventory({ siteRoot, naradaDir });
  const normalizedFilterKey = normalizeSessionInventoryFilterKey(filterKey);
  const normalizedFilterValue = normalizeSessionInventoryFilterValue(filterValue);
  const filteredInventory = filterSessionInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const hostCommandQueue = summarizeSessionInventoryHostCommands(filteredInventory);
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_inventory_host_commands.v1',
      site_root: siteRoot,
      inventory_filter: filterLabel,
      carrier_session_count: hostCommandQueue.host_command_session_count,
      total_carrier_session_count: inventory.length,
      host_command_event_counts: hostCommandQueue.host_command_event_counts,
      host_command_event_summary: hostCommandQueue.host_command_event_summary,
      host_command_terminal_state_counts: hostCommandQueue.host_command_terminal_state_counts,
      host_command_terminal_state_summary: hostCommandQueue.host_command_terminal_state_summary,
      host_command_output_ref_count: hostCommandQueue.host_command_output_ref_count,
      host_command_output_ref_summary: hostCommandQueue.host_command_output_ref_summary,
      groups: hostCommandQueue.groups,
      workflow_groups: hostCommandQueue.workflow_groups,
      sessions: hostCommandQueue.sessions,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Inventory filter': filterLabel, 'Matched sessions': hostCommandQueue.host_command_session_count, 'Total sessions': inventory.length } : { 'Carrier sessions': hostCommandQueue.host_command_session_count }),
    'Host command events': hostCommandQueue.host_command_event_summary,
    'Host command states': hostCommandQueue.host_command_terminal_state_summary,
    'Persisted outputs': hostCommandQueue.host_command_output_ref_summary,
  };
  if (hostCommandQueue.host_command_session_count === 0) {
    summary.Status = 'no persisted host command activity';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary), ...renderSessionInventoryHostCommands(hostCommandQueue.sessions)];
  blocks.push(renderSessionInventoryWorkflowGroups(hostCommandQueue.workflow_groups, { heading: 'Host command action groups' }));
  blocks.push(renderSessionInventoryGroups(hostCommandQueue.groups));
  console.log(blocks.join('\n\n'));
  return 0;
}

async function runSessionInventoryOperations({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false, filterKey = null, filterValue = null } = {}) {
  const inventory = readSessionInventory({ siteRoot, naradaDir });
  const normalizedFilterKey = normalizeSessionInventoryFilterKey(filterKey);
  const normalizedFilterValue = normalizeSessionInventoryFilterValue(filterValue);
  const filteredInventory = filterSessionInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const operationQueue = summarizeSessionInventoryOperations(filteredInventory);
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_inventory_operations.v1',
      site_root: siteRoot,
      inventory_filter: filterLabel,
      carrier_session_count: operationQueue.operation_session_count,
      total_carrier_session_count: inventory.length,
      operation_event_counts: operationQueue.operation_event_counts,
      operation_event_summary: operationQueue.operation_event_summary,
      directive_kind_counts: operationQueue.directive_kind_counts,
      directive_kind_summary: operationQueue.directive_kind_summary,
      directive_visibility_counts: operationQueue.directive_visibility_counts,
      directive_visibility_summary: operationQueue.directive_visibility_summary,
      operation_id_counts: operationQueue.operation_id_counts,
      operation_id_summary: operationQueue.operation_id_summary,
      groups: operationQueue.groups,
      workflow_groups: operationQueue.workflow_groups,
      sessions: operationQueue.sessions,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Inventory filter': filterLabel, 'Matched sessions': operationQueue.operation_session_count, 'Total sessions': inventory.length } : { 'Carrier sessions': operationQueue.operation_session_count }),
    'Operation events': operationQueue.operation_event_summary,
    'Directive kinds': operationQueue.directive_kind_summary,
    'Directive visibility': operationQueue.directive_visibility_summary,
    'Operation ids': operationQueue.operation_id_summary,
  };
  if (operationQueue.operation_session_count === 0) {
    summary.Status = 'no persisted operation activity';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary), ...renderSessionInventoryOperations(operationQueue.sessions)];
  blocks.push(renderSessionInventoryWorkflowGroups(operationQueue.workflow_groups, { heading: 'Operation action groups' }));
  blocks.push(renderSessionInventoryGroups(operationQueue.groups));
  console.log(blocks.join('\n\n'));
  return 0;
}

async function runSessionOperationsRead({ session = SESSION, siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false } = {}) {
  const sessionRecord = readPersistedSession({ session, siteRoot, naradaDir });
  if (!sessionRecord) {
    if (jsonOutput) {
      console.log(`${JSON.stringify({
        schema: 'narada.agent_cli.session_operations.v1',
        site_root: siteRoot,
        session,
        found: false,
      }, null, 2)}\n`);
    } else {
      console.log(formatKeyValueRows({
        SiteRoot: siteRoot,
        Session: session,
        Status: 'persisted session not found',
      }));
    }
    return 0;
  }
  const sessionEventSummary = createSessionEventSummaryPayload(sessionRecord, { naradaDir, eventFilter: 'all', recentCount: 20 });
  const sessionOperationPayload = createSessionOperationPayload(sessionRecord);
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_operations.v1',
      site_root: siteRoot,
      session,
      found: true,
      operation: sessionOperationPayload,
      event_summary: sessionEventSummary,
      recovery: createSessionRecoveryPayload(sessionRecord),
      preflight: createSessionPreflightPayload(sessionRecord),
      host_command_output: createSessionHostCommandOutputPayload(sessionRecord),
      record: sessionRecord,
    }, null, 2)}\n`);
    return 0;
  }
  console.log(formatKeyValueRows({
    SiteRoot: siteRoot,
    Session: sessionRecord.session,
    Agent: sessionRecord.agent_id ?? 'unknown',
    Runtime: sessionRecord.runtime ?? 'unknown',
    Mode: sessionRecord.mode ?? 'unknown',
    Started: sessionRecord.started_at ?? 'unknown',
    Heartbeat: sessionRecord.heartbeat_display,
    'Operational posture': sessionRecord.operational_posture_display,
    'MCP state': sessionRecord.mcp_operational_state,
    'Request posture': sessionRecord.request_posture_display,
    'Operation events': sessionOperationPayload.operation_event_summary,
    'Directive kinds': sessionOperationPayload.directive_kind_summary,
    'Directive visibility': sessionOperationPayload.directive_visibility_summary,
    'Operation ids': sessionOperationPayload.operation_id_summary,
    'Last operation id': sessionOperationPayload.last_operation_id ?? 'none',
    'Last directive kind': sessionOperationPayload.last_directive_kind ?? 'none',
    'Last directive visibility': sessionOperationPayload.last_directive_visibility ?? 'none',
    'Last operation event': sessionOperationPayload.last_operation_event_kind ?? 'none',
    'Last operation at': sessionOperationPayload.last_operation_at ?? 'unknown',
    'Event count': sessionEventSummary.event_count,
    'Event kinds': sessionEventSummary.event_kind_summary,
    'Issue codes': sessionEventSummary.issue_code_summary,
    'Terminal states': sessionEventSummary.terminal_state_summary,
    'Recovery kind': sessionRecord.recovery_kind_display ?? 'none',
    'Recovery primary': sessionRecord.recovery_primary_command ?? 'none',
    'Recovery followup': sessionRecord.recovery_followup_command ?? 'none',
    'Recommended action': sessionRecord.recommended_action_display,
    'Recommended command': sessionRecord.recommended_command ?? 'none',
    'Session operations': sessionOperationPayload.handoffs.session_operations ?? 'none',
    'Session read': sessionRecord?.handoffs?.session_read ?? 'none',
    'Session recovery': sessionRecord?.handoffs?.session_recovery ?? 'none',
    'Session issues': sessionRecord?.handoffs?.session_events_issues ?? 'none',
    'Session diagnostics': sessionRecord?.handoffs?.session_events_diagnostics ?? 'none',
    'Host command output review': sessionRecord?.handoffs?.host_command_output_read ?? 'none',
    'Session path': sessionRecord.session_path,
  }));
  return 0;
}

async function runSessionInventoryActions({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false, filterKey = null, filterValue = null } = {}) {
  const inventory = readSessionInventory({ siteRoot, naradaDir });
  const normalizedFilterKey = normalizeSessionInventoryFilterKey(filterKey);
  const normalizedFilterValue = normalizeSessionInventoryFilterValue(filterValue);
  const filteredInventory = filterSessionInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const actionQueue = summarizeSessionInventoryActions(filteredInventory);
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_inventory_actions.v1',
      site_root: siteRoot,
      carrier_session_count: filteredInventory.length,
      total_carrier_session_count: inventory.length,
      inventory_filter: filterLabel,
      summary: {
        recommended_action_counts: actionQueue.recommended_action_counts,
        recommended_action_summary: actionQueue.recommended_action_summary,
        recommended_command_counts: actionQueue.recommended_command_counts,
        recommended_command_summary: actionQueue.recommended_command_summary,
        recovery_primary_counts: actionQueue.recovery_primary_counts,
        recovery_primary_summary: actionQueue.recovery_primary_summary,
        recovery_followup_counts: actionQueue.recovery_followup_counts,
        recovery_followup_summary: actionQueue.recovery_followup_summary,
      },
      workflow_groups: actionQueue.workflow_groups,
      actions: actionQueue.actions,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Inventory filter': filterLabel, 'Matched sessions': filteredInventory.length, 'Total sessions': inventory.length } : { 'Carrier sessions': filteredInventory.length }),
    'Action queue': actionQueue.action_count,
    'Recommended actions': actionQueue.recommended_action_summary,
    'Recommended commands': actionQueue.recommended_command_summary,
    'Recovery primary commands': actionQueue.recovery_primary_summary,
    'Recovery followups': actionQueue.recovery_followup_summary,
  };
  if (actionQueue.action_count === 0) {
    summary.Status = 'no persisted carrier session actions';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary), ...renderSessionInventoryActions(actionQueue.actions), renderSessionInventoryWorkflowGroups(actionQueue.workflow_groups, { heading: 'Action groups' })];
  console.log(blocks.join('\n\n'));
  return 0;
}

async function runSessionInventoryRecovery({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false, filterKey = null, filterValue = null } = {}) {
  const inventory = readSessionInventory({ siteRoot, naradaDir });
  const normalizedFilterKey = normalizeSessionInventoryFilterKey(filterKey);
  const normalizedFilterValue = normalizeSessionInventoryFilterValue(filterValue);
  const filteredInventory = filterSessionInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const recoveryQueue = summarizeSessionInventoryRecoveryQueue(filteredInventory);
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_inventory_recovery.v1',
      site_root: siteRoot,
      carrier_session_count: recoveryQueue.recovery_count,
      total_carrier_session_count: inventory.length,
      inventory_filter: filterLabel,
      summary: {
        recommended_action_counts: recoveryQueue.recommended_action_counts,
        recommended_action_summary: recoveryQueue.recommended_action_summary,
        recovery_kind_counts: recoveryQueue.recovery_kind_counts,
        recovery_kind_summary: recoveryQueue.recovery_kind_summary,
        recovery_primary_counts: recoveryQueue.recovery_primary_counts,
        recovery_primary_summary: recoveryQueue.recovery_primary_summary,
        recovery_followup_counts: recoveryQueue.recovery_followup_counts,
        recovery_followup_summary: recoveryQueue.recovery_followup_summary,
      },
      groups: recoveryQueue.groups,
      workflow_groups: recoveryQueue.workflow_groups,
      actions: recoveryQueue.actions,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Inventory filter': filterLabel, 'Matched sessions': filteredInventory.length, 'Total sessions': inventory.length } : { 'Carrier sessions': inventory.length }),
    'Recovery queue': recoveryQueue.recovery_count,
    'Recommended actions': recoveryQueue.recommended_action_summary,
    'Recovery kinds': recoveryQueue.recovery_kind_summary,
    'Recovery primary commands': recoveryQueue.recovery_primary_summary,
    'Recovery followups': recoveryQueue.recovery_followup_summary,
  };
  if (recoveryQueue.recovery_count === 0) {
    summary.Status = 'no persisted carrier session recoveries';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary), ...renderSessionInventoryActions(recoveryQueue.actions), renderSessionInventoryWorkflowGroups(recoveryQueue.workflow_groups, { heading: 'Recovery groups' })];
  console.log(blocks.join('\n\n'));
  return 0;
}

async function runSessionInventoryEvents({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false, filterKey = null, filterValue = null, eventFilter = 'all', recentCount = 20 } = {}) {
  const inventory = readSessionInventory({ siteRoot, naradaDir });
  const normalizedFilterKey = normalizeSessionInventoryFilterKey(filterKey);
  const normalizedFilterValue = normalizeSessionInventoryFilterValue(filterValue);
  const filteredInventory = filterSessionInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const inventoryEventSummary = summarizeSessionInventoryEvents(filteredInventory, { naradaDir, eventFilter, recentCount });
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_inventory_events.v1',
      site_root: siteRoot,
      inventory_filter: filterLabel,
      event_filter: inventoryEventSummary.event_filter,
      carrier_session_count: filteredInventory.length,
      total_carrier_session_count: inventory.length,
      sessions_with_events: inventoryEventSummary.sessions.length,
      event_count: inventoryEventSummary.event_count,
      event_kind_counts: inventoryEventSummary.event_kind_counts,
      event_kind_summary: inventoryEventSummary.event_kind_summary,
      issue_code_counts: inventoryEventSummary.issue_code_counts,
      issue_code_summary: inventoryEventSummary.issue_code_summary,
      terminal_state_counts: inventoryEventSummary.terminal_state_counts,
      terminal_state_summary: inventoryEventSummary.terminal_state_summary,
      recommended_action_counts: inventoryEventSummary.recommended_action_counts,
      recommended_action_summary: inventoryEventSummary.recommended_action_summary,
      recommended_command_counts: inventoryEventSummary.recommended_command_counts,
      recommended_command_summary: inventoryEventSummary.recommended_command_summary,
      recovery_primary_counts: inventoryEventSummary.recovery_primary_counts,
      recovery_primary_summary: inventoryEventSummary.recovery_primary_summary,
      recovery_followup_counts: inventoryEventSummary.recovery_followup_counts,
      recovery_followup_summary: inventoryEventSummary.recovery_followup_summary,
      groups: inventoryEventSummary.groups,
      workflow_groups: inventoryEventSummary.workflow_groups,
      sessions: inventoryEventSummary.sessions,
      recent_events: inventoryEventSummary.recent_events,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Inventory filter': filterLabel, 'Matched sessions': filteredInventory.length, 'Total sessions': inventory.length } : { 'Carrier sessions': filteredInventory.length }),
    'Event filter': inventoryEventSummary.event_filter,
    'Sessions with events': inventoryEventSummary.sessions.length,
    'Event count': inventoryEventSummary.event_count,
    'Event kinds': inventoryEventSummary.event_kind_summary,
    'Issue codes': inventoryEventSummary.issue_code_summary,
    'Terminal states': inventoryEventSummary.terminal_state_summary,
    'Recommended actions': inventoryEventSummary.recommended_action_summary,
    'Recommended commands': inventoryEventSummary.recommended_command_summary,
    'Recovery primary commands': inventoryEventSummary.recovery_primary_summary,
    'Recovery followups': inventoryEventSummary.recovery_followup_summary,
  };
  if (inventoryEventSummary.event_count === 0) {
    summary.Status = 'no persisted carrier session events';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary)];
  for (const item of inventoryEventSummary.sessions) {
    blocks.push(formatKeyValueRows({
      Session: item.session,
      'Event count': item.event_count,
      'Last event': item.last_event_kind,
      'Last event at': item.last_event_at,
      'Recommended action': item.recommended_action_display,
      'Recommended command': item.recommended_command ?? 'none',
      'Session read': item?.handoffs?.session_read ?? 'none',
      'Session recovery': item?.handoffs?.session_recovery ?? 'none',
      'Session issues': item?.handoffs?.session_events_issues ?? 'none',
      'Session diagnostics': item?.handoffs?.session_events_diagnostics ?? 'none',
      'Host command output review': item?.handoffs?.host_command_output_read ?? 'none',
    }));
  }
  if (inventoryEventSummary.recent_events.length > 0) {
    blocks.push(['Recent events:', ...inventoryEventSummary.recent_events.map((entry) => formatPersistedSessionInventoryEventLine(entry))].join('\n'));
  }
  blocks.push(renderSessionInventoryWorkflowGroups(inventoryEventSummary.workflow_groups, { heading: 'Event action groups' }));
  blocks.push(renderSessionInventoryEventGroups(inventoryEventSummary.groups));
  console.log(blocks.join('\n\n'));
  return 0;
}

function createSessionRecoveryPayload(sessionRecord) {
  if (!sessionRecord) return null;
  return {
    recovery_kind: sessionRecord.recovery_kind,
    recovery_kind_display: sessionRecord.recovery_kind_display,
    recovery_primary_command: sessionRecord.recovery_primary_command,
    recovery_followup_command: sessionRecord.recovery_followup_command,
    recommended_action: sessionRecord.recommended_action,
    recommended_action_display: sessionRecord.recommended_action_display,
    recommended_command: sessionRecord.recommended_command,
  };
}

function createSessionOperationPayload(sessionRecord) {
  if (!sessionRecord) return null;
  return {
    operation_event_count: sessionRecord.operation_event_count ?? 0,
    operation_event_counts: sessionRecord.operation_event_counts ?? {},
    operation_event_summary: sessionRecord.operation_event_summary ?? '0',
    directive_kind_counts: sessionRecord.directive_kind_counts ?? {},
    directive_kind_summary: sessionRecord.directive_kind_summary ?? '0',
    directive_visibility_counts: sessionRecord.directive_visibility_counts ?? {},
    directive_visibility_summary: sessionRecord.directive_visibility_summary ?? '0',
    operation_id_counts: sessionRecord.operation_id_counts ?? {},
    operation_id_summary: sessionRecord.operation_id_summary ?? '0',
    last_operation_id: sessionRecord.last_operation_id ?? null,
    last_directive_kind: sessionRecord.last_directive_kind ?? null,
    last_directive_visibility: sessionRecord.last_directive_visibility ?? null,
    last_operation_event_kind: sessionRecord.last_operation_event_kind ?? null,
    last_operation_at: sessionRecord.last_operation_at ?? null,
    handoffs: {
      session_operations: sessionRecord?.handoffs?.session_operations ?? null,
      session_operations_json: sessionRecord?.handoffs?.session_operations_json ?? null,
      session_read: sessionRecord?.handoffs?.session_read ?? null,
      session_recovery: sessionRecord?.handoffs?.session_recovery ?? null,
      session_events_issues: sessionRecord?.handoffs?.session_events_issues ?? null,
      session_events_diagnostics: sessionRecord?.handoffs?.session_events_diagnostics ?? null,
      host_command_output_read: sessionRecord?.handoffs?.host_command_output_read ?? null,
    },
  };
}

function createSessionPreflightPayload(sessionRecord) {
  if (!sessionRecord) return null;
  return {
    artifact_path: sessionRecord.mcp_preflight_artifact_path ?? null,
    operational_state: sessionRecord.mcp_preflight_operational_state ?? null,
    startup_failure_summary: sessionRecord.mcp_preflight_startup_failure_summary ?? null,
    runtime_fault_summary: sessionRecord.mcp_preflight_runtime_fault_summary ?? null,
    recommended_action: sessionRecord.mcp_preflight_recommended_action ?? null,
    recommended_action_display: sessionRecord.mcp_preflight_recommended_action_display ?? null,
    recommended_command: sessionRecord.mcp_preflight_recommended_command ?? null,
    recovery_kind: sessionRecord.mcp_preflight_recovery_kind ?? null,
    recovery_kind_display: sessionRecord.mcp_preflight_recovery_kind_display ?? null,
    recovery_primary_command: sessionRecord.mcp_preflight_recovery_primary_command ?? null,
    recovery_followup_command: sessionRecord.mcp_preflight_recovery_followup_command ?? null,
    handoffs: sessionRecord.mcp_preflight_handoffs ?? null,
  };
}

function createSessionHostCommandOutputPayload(sessionRecord) {
  if (!sessionRecord) return null;
  return {
    output_ref: sessionRecord.last_host_command_output_ref ?? null,
    reader_tool: sessionRecord.last_host_command_output_reader_tool ?? null,
    command_id: sessionRecord.last_host_command_id ?? null,
    command_summary: sessionRecord.last_host_command_summary ?? null,
    terminal_state: sessionRecord.last_host_command_terminal_state ?? null,
    handoffs: {
      host_command_output_read: sessionRecord?.handoffs?.host_command_output_read ?? null,
      host_command_output_read_json: sessionRecord?.handoffs?.host_command_output_read_json ?? null,
    },
  };
}

function createSessionEventSummaryPayload(sessionRecord, { naradaDir, eventFilter = 'all', recentCount = 20 } = {}) {
  if (!sessionRecord) return null;
  const sessionEventSummary = summarizeSessionInventoryEvents([sessionRecord], { naradaDir, eventFilter, recentCount });
  return {
    event_count: sessionEventSummary.event_count,
    event_kind_counts: sessionEventSummary.event_kind_counts,
    event_kind_summary: sessionEventSummary.event_kind_summary,
    issue_code_counts: sessionEventSummary.issue_code_counts,
    issue_code_summary: sessionEventSummary.issue_code_summary,
    terminal_state_counts: sessionEventSummary.terminal_state_counts,
    terminal_state_summary: sessionEventSummary.terminal_state_summary,
    recommended_action_counts: sessionEventSummary.recommended_action_counts,
    recommended_action_summary: sessionEventSummary.recommended_action_summary,
    recommended_command_counts: sessionEventSummary.recommended_command_counts,
    recommended_command_summary: sessionEventSummary.recommended_command_summary,
    recovery_primary_counts: sessionEventSummary.recovery_primary_counts,
    recovery_primary_summary: sessionEventSummary.recovery_primary_summary,
    recovery_followup_counts: sessionEventSummary.recovery_followup_counts,
    recovery_followup_summary: sessionEventSummary.recovery_followup_summary,
    groups: sessionEventSummary.groups,
    workflow_groups: sessionEventSummary.workflow_groups,
  };
}

async function runSessionRecovery({ session = SESSION, siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false } = {}) {
  const sessionRecord = readPersistedSession({ session, siteRoot, naradaDir });
  if (!sessionRecord) {
    if (jsonOutput) {
      console.log(`${JSON.stringify({
        schema: 'narada.agent_cli.session_recovery.v1',
        site_root: siteRoot,
        session,
        found: false,
      }, null, 2)}\n`);
    } else {
      console.log(formatKeyValueRows({
        SiteRoot: siteRoot,
        Session: session,
        Status: 'persisted session not found',
      }));
    }
    return 0;
  }
  const sessionEventSummary = createSessionEventSummaryPayload(sessionRecord, { naradaDir, eventFilter: 'all', recentCount: 20 });
  const sessionOperationPayload = createSessionOperationPayload(sessionRecord);
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_recovery.v1',
      site_root: siteRoot,
      session,
      found: true,
      operation: sessionOperationPayload,
      recovery: createSessionRecoveryPayload(sessionRecord),
      preflight: createSessionPreflightPayload(sessionRecord),
      host_command_output: createSessionHostCommandOutputPayload(sessionRecord),
      event_summary: sessionEventSummary,
      record: sessionRecord,
    }, null, 2)}\n`);
    return 0;
  }
  console.log(formatKeyValueRows({
    SiteRoot: siteRoot,
    Session: sessionRecord.session,
    'Operational posture': sessionRecord.operational_posture_display,
    'MCP state': sessionRecord.mcp_operational_state,
    'Request posture': sessionRecord.request_posture_display,
    'Host command states': sessionRecord.host_command_terminal_state_summary,
    'Last host command': sessionRecord.last_host_command_summary ?? 'none',
    'Last host command state': sessionRecord.last_host_command_terminal_state ?? 'none',
    'Recovery kind': sessionRecord.recovery_kind_display ?? 'none',
    'Recovery primary': sessionRecord.recovery_primary_command ?? 'none',
    'Recovery followup': sessionRecord.recovery_followup_command ?? 'none',
    'Recommended action': sessionRecord.recommended_action_display,
    'Recommended command': sessionRecord.recommended_command ?? 'none',
    'Event count': sessionEventSummary.event_count,
    'Event kinds': sessionEventSummary.event_kind_summary,
    'Issue codes': sessionEventSummary.issue_code_summary,
    'Terminal states': sessionEventSummary.terminal_state_summary,
    'Host command output review': sessionRecord?.handoffs?.host_command_output_read ?? 'none',
    'Preflight state': sessionRecord.mcp_preflight_operational_state ?? 'none',
    'Preflight action': sessionRecord.mcp_preflight_recommended_action_display ?? 'none',
    'Preflight command': sessionRecord.mcp_preflight_recommended_command ?? 'none',
    'Preflight diagnostics': sessionRecord?.mcp_preflight_handoffs?.mcp_preflight_diagnostics ?? 'none',
    'Operation events': sessionOperationPayload.operation_event_summary,
    'Directive kinds': sessionOperationPayload.directive_kind_summary,
    'Directive visibility': sessionOperationPayload.directive_visibility_summary,
    'Operation ids': sessionOperationPayload.operation_id_summary,
    'Last operation id': sessionOperationPayload.last_operation_id ?? 'none',
    'Last directive kind': sessionOperationPayload.last_directive_kind ?? 'none',
    'Last directive visibility': sessionOperationPayload.last_directive_visibility ?? 'none',
    'Last operation event': sessionOperationPayload.last_operation_event_kind ?? 'none',
    'Last operation at': sessionOperationPayload.last_operation_at ?? 'unknown',
    'Session operations': sessionOperationPayload.handoffs.session_operations ?? 'none',
    'Session read': sessionRecord?.handoffs?.session_read ?? 'none',
    'Session recovery': sessionRecord?.handoffs?.session_recovery ?? 'none',
    'Session issues': sessionRecord?.handoffs?.session_events_issues ?? 'none',
    'Session diagnostics': sessionRecord?.handoffs?.session_events_diagnostics ?? 'none',
    'Session path': sessionRecord.session_path,
  }));
  return 0;
}

async function runSessionEventsRead({ session = SESSION, siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false, recentCount = 20, eventFilter = 'all' } = {}) {
  const sessionRecord = readPersistedSession({ session, siteRoot, naradaDir });
  const events = readPersistedSessionEvents({ session, naradaDir });
  const normalizedEventFilter = normalizeSessionEventsFilter(eventFilter);
  const filteredEvents = filterPersistedSessionEvents(events, { eventFilter: normalizedEventFilter });
  if (!sessionRecord) {
    if (jsonOutput) {
      console.log(`${JSON.stringify({
        schema: 'narada.agent_cli.session_events_read.v1',
        site_root: siteRoot,
        session,
        found: false,
        event_filter: normalizedEventFilter,
        event_count: 0,
        total_event_count: 0,
        recent_events: [],
      }, null, 2)}\n`);
    } else {
      console.log(formatKeyValueRows({
        SiteRoot: siteRoot,
        Session: session,
        Status: 'persisted session not found',
      }));
    }
    return 0;
  }
  const recentEvents = filteredEvents.slice(-recentCount);
  const sessionEventSummary = createSessionEventSummaryPayload(sessionRecord, { naradaDir, eventFilter: normalizedEventFilter, recentCount });
  const sessionOperationPayload = createSessionOperationPayload(sessionRecord);
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_events_read.v1',
      site_root: siteRoot,
      session,
      found: true,
      event_filter: normalizedEventFilter,
      event_count: filteredEvents.length,
      total_event_count: events.length,
      operation: sessionOperationPayload,
      event_kind_counts: sessionEventSummary.event_kind_counts,
      event_kind_summary: sessionEventSummary.event_kind_summary,
      issue_code_counts: sessionEventSummary.issue_code_counts,
      issue_code_summary: sessionEventSummary.issue_code_summary,
      terminal_state_counts: sessionEventSummary.terminal_state_counts,
      terminal_state_summary: sessionEventSummary.terminal_state_summary,
      recommended_action_counts: sessionEventSummary.recommended_action_counts,
      recommended_action_summary: sessionEventSummary.recommended_action_summary,
      recommended_command_counts: sessionEventSummary.recommended_command_counts,
      recommended_command_summary: sessionEventSummary.recommended_command_summary,
      recovery_primary_counts: sessionEventSummary.recovery_primary_counts,
      recovery_primary_summary: sessionEventSummary.recovery_primary_summary,
      recovery_followup_counts: sessionEventSummary.recovery_followup_counts,
      recovery_followup_summary: sessionEventSummary.recovery_followup_summary,
      groups: sessionEventSummary.groups,
      workflow_groups: sessionEventSummary.workflow_groups,
      recent_events: recentEvents,
      recovery: createSessionRecoveryPayload(sessionRecord),
      preflight: createSessionPreflightPayload(sessionRecord),
      host_command_output: createSessionHostCommandOutputPayload(sessionRecord),
      record: sessionRecord,
    }, null, 2)}\n`);
    return 0;
  }
  const blocks = [formatKeyValueRows({
    SiteRoot: siteRoot,
    Session: sessionRecord.session,
    'Event filter': normalizedEventFilter,
    'Event count': filteredEvents.length,
    'Total event count': events.length,
    'Event kinds': sessionEventSummary.event_kind_summary,
    'Issue codes': sessionEventSummary.issue_code_summary,
    'Terminal states': sessionEventSummary.terminal_state_summary,
    'Operation events': sessionOperationPayload.operation_event_summary,
    'Directive kinds': sessionOperationPayload.directive_kind_summary,
    'Directive visibility': sessionOperationPayload.directive_visibility_summary,
    'Operation ids': sessionOperationPayload.operation_id_summary,
    'Last operation id': sessionOperationPayload.last_operation_id ?? 'none',
    'Last directive kind': sessionOperationPayload.last_directive_kind ?? 'none',
    'Last directive visibility': sessionOperationPayload.last_directive_visibility ?? 'none',
    'Last operation event': sessionOperationPayload.last_operation_event_kind ?? 'none',
    'Last operation at': sessionOperationPayload.last_operation_at ?? 'unknown',
    'Host command states': sessionRecord.host_command_terminal_state_summary,
    'Last host command': sessionRecord.last_host_command_summary ?? 'none',
    'Last host command state': sessionRecord.last_host_command_terminal_state ?? 'none',
    'Last event': sessionRecord.last_event_kind ?? 'none',
    'Last event at': sessionRecord.last_event_at ?? 'unknown',
    'Operational posture': sessionRecord.operational_posture_display,
    'Request posture': sessionRecord.request_posture_display,
    'Lifecycle outcomes': sessionRecord.lifecycle_state_summary,
    'Request issues': sessionRecord.request_issue_summary,
    'Recovery kind': sessionRecord.recovery_kind_display ?? 'none',
    'Recovery primary': sessionRecord.recovery_primary_command ?? 'none',
    'Recovery followup': sessionRecord.recovery_followup_command ?? 'none',
    'Recommended action': sessionRecord.recommended_action_display,
    'Recommended command': sessionRecord.recommended_command ?? 'none',
    'Preflight state': sessionRecord.mcp_preflight_operational_state ?? 'none',
    'Preflight action': sessionRecord.mcp_preflight_recommended_action_display ?? 'none',
    'Preflight command': sessionRecord.mcp_preflight_recommended_command ?? 'none',
    'Preflight diagnostics': sessionRecord?.mcp_preflight_handoffs?.mcp_preflight_diagnostics ?? 'none',
    'Session operations': sessionOperationPayload.handoffs.session_operations ?? 'none',
    'Session recovery': sessionRecord?.handoffs?.session_recovery ?? 'none',
    'Session read': sessionRecord?.handoffs?.session_read ?? 'none',
    'Session issues': sessionRecord?.handoffs?.session_events_issues ?? 'none',
    'Session diagnostics': sessionRecord?.handoffs?.session_events_diagnostics ?? 'none',
    'Host command output review': sessionRecord?.handoffs?.host_command_output_read ?? 'none',
    'Session path': sessionRecord.session_path,
  })];
  if (recentEvents.length > 0) {
    blocks.push(['Recent events:', ...recentEvents.map((entry) => formatPersistedSessionEventLine(entry))].join('\n'));
  }
  console.log(blocks.join('\n\n'));
  return 0;
}

function buildSessionSyncSummary({
  session = SESSION,
  target = null,
  direction = 'upload',
  siteRoot = SITE_ROOT,
  naradaDir = NARADA_DIR,
  dryRun = false,
  deleteMissing = false,
} = {}) {
  if (!target) {
    return {
      exitCode: 1,
      summary: {
        schema: 'narada.agent_cli.session_sync.v1',
        site_root: siteRoot,
        session,
        success: false,
        status: 'missing_target',
        message: '--session-sync-target is required for session sync.',
      },
    };
  }

  const targetResolution = resolveSessionSyncTarget({ target });
  if (!targetResolution.ok) {
    return {
      exitCode: 1,
      summary: {
        schema: 'narada.agent_cli.session_sync.v1',
        site_root: siteRoot,
        session,
        success: false,
        status: targetResolution.status,
        message: targetResolution.message,
      },
    };
  }

  const source = resolveSessionSyncDirectoryRoots({ siteRoot, session, naradaDir });
  const destination = resolveSessionSyncDirectoryRoots({
    siteRoot: targetResolution.siteRoot,
    session,
    naradaDir,
  });
  cleanupSessionSyncStagingDirectories(source, destination);
  const directionResult = runSessionSyncDirection({
    direction,
    source,
    destination,
    session,
    dryRun,
    deleteMissing,
  });
  cleanupSessionSyncStagingDirectories(source, destination);
  const summary = {
    schema: 'narada.agent_cli.session_sync.v1',
    site_root: siteRoot,
    session,
    target,
    target_scheme: targetResolution.scheme,
    target_alias: targetResolution.alias,
    target_resolved_root: targetResolution.siteRoot,
    dry_run: dryRun,
    direction,
    source_session_root: source.sessionDir,
    source_carrier_session_root: source.carrierDir,
    destination_session_root: destination.sessionDir,
    destination_carrier_session_root: destination.carrierDir,
    delete_missing: deleteMissing,
    ...directionResult,
  };

  return {
    exitCode: directionResult.success ? 0 : 1,
    summary,
    success: directionResult.success,
    directionResult,
    targetResolution,
  };
}

async function runSessionSync({
  session = SESSION,
  target = null,
  direction = 'upload',
  siteRoot = SITE_ROOT,
  naradaDir = NARADA_DIR,
  jsonOutput = false,
  transport = 'cli',
  requestId = null,
  recordWorkflow = true,
  dryRun = false,
  deleteMissing = false,
} = {}) {
  const workflowStartedAt = new Date();
  const { summary, exitCode, directionResult = null } = buildSessionSyncSummary({
    session,
    target,
    direction,
    siteRoot,
    naradaDir,
    dryRun,
    deleteMissing,
  });
  if (recordWorkflow) {
    const workflowCompletedAt = new Date();
    const workflowStartedIso = workflowStartedAt.toISOString();
    const workflowCompletedIso = workflowCompletedAt.toISOString();
    const workflowDurationMs = workflowCompletedAt.getTime() - workflowStartedAt.getTime();
    recordSessionSyncWorkflow({
      event: 'session_sync_requested',
      requestId,
      session,
      target,
      direction,
      dryRun,
      deleteMissing,
      summary,
      directionResult,
      exitCode,
      transport,
      naradaDir,
      operation_status: 'requested',
      requested_at: workflowStartedIso,
      completed_at: workflowCompletedIso,
      duration_ms: workflowDurationMs,
    });
    recordSessionSyncWorkflow({
      event: 'session_sync_completed',
      requestId,
      session,
      target,
      direction,
      dryRun,
      deleteMissing,
      summary,
      directionResult,
      exitCode,
      transport,
      naradaDir,
      operation_status: exitCode === 0 ? 'succeeded' : 'failed',
      requested_at: workflowStartedIso,
      completed_at: workflowCompletedIso,
      duration_ms: workflowDurationMs,
    });
  }
  if (jsonOutput) {
    console.log(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    console.log(formatKeyValueRows({
      SiteRoot: siteRoot,
      Session: session,
      Target: target,
      Mode: dryRun ? 'dry-run' : 'live',
      Direction: direction,
      'Session root sync result': `${directionResult?.copied ?? 0} copied / ${directionResult?.skipped ?? 0} skipped`,
      'Carrier session root sync result': `${directionResult?.carrierCopied ?? 0} copied / ${directionResult?.carrierSkipped ?? 0} skipped`,
      'Deleted files': `${directionResult?.deleted ?? 0} deleted`,
      Status: summary?.success ? 'session sync completed' : 'session sync completed with conflicts',
      Message: summary?.message ?? 'ok',
    }));
  }
  return exitCode;
}

function hashStable(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sessionSyncOperationId({ session, target, direction = 'upload', requestId = null, dryRun = false, deleteMissing = false }) {
  const base = {
    kind: 'session_sync',
    session,
    target: target ?? null,
    direction,
    requestId,
    dryRun: !!dryRun,
    deleteMissing: !!deleteMissing,
  };
  return `operation_session_sync_${hashStable(base).slice(0, 16)}`;
}

function recordSessionSyncWorkflow({
  event = 'session_sync_requested',
  requestId = null,
  session = SESSION,
  target = null,
  direction = 'upload',
  dryRun = false,
  deleteMissing = false,
  summary = null,
  directionResult = null,
  exitCode = 0,
  transport = 'jsonl_stdio',
  naradaDir = NARADA_DIR,
  method = 'session.sync',
  operation_status = null,
  requested_at = null,
  completed_at = null,
  duration_ms = null,
}) {
  const operationId = sessionSyncOperationId({ session, target, direction, requestId, dryRun, deleteMissing });
  const normalizedSummary = summary ?? {};
  const syncTarget = normalizedSummary.target ?? target ?? null;
  const sessionPath = join(naradaDir, 'crew', 'nars-sessions', session, 'session.jsonl');
  const result = {
    session,
    target: syncTarget,
    method,
    target_scheme: normalizedSummary.target_scheme ?? null,
    target_alias: normalizedSummary.target_alias ?? null,
    target_resolved_root: normalizedSummary.target_resolved_root ?? null,
    source_session_root: normalizedSummary.source_session_root ?? null,
    destination_session_root: normalizedSummary.destination_session_root ?? null,
    source_carrier_session_root: normalizedSummary.source_carrier_session_root ?? null,
    destination_carrier_session_root: normalizedSummary.destination_carrier_session_root ?? null,
    direction,
    dry_run: !!dryRun,
    delete_missing: !!deleteMissing,
    transport,
    status: normalizedSummary.status ?? null,
    message: normalizedSummary.message ?? null,
    success: exitCode === 0,
    copied: directionResult?.copied ?? normalizedSummary.copied ?? 0,
    skipped: directionResult?.skipped ?? normalizedSummary.skipped ?? 0,
    conflicts: directionResult?.conflicts ?? normalizedSummary.conflicts ?? 0,
    deleted: directionResult?.deleted ?? normalizedSummary.deleted ?? 0,
    carrier_copied: directionResult?.carrierCopied ?? normalizedSummary.carrierCopied ?? 0,
    carrier_skipped: directionResult?.carrierSkipped ?? normalizedSummary.carrierSkipped ?? 0,
    carrier_deleted: directionResult?.carrierDeleted ?? normalizedSummary.carrierDeleted ?? 0,
    requested_at,
    completed_at,
    duration_ms,
    operation_status,
    operation_id: operationId,
    request_id: requestId,
  };
  appendSession(sessionPath, sessionEventEntry(event, result));
}

function resolveSessionSyncTarget({ target }) {
  const normalized = String(target ?? '').trim();
  if (!normalized) {
    return { ok: false, status: 'missing_target', message: '--session-sync-target is required for session sync.' };
  }

  const fileTarget = normalizeSessionSyncFileTarget(normalized);
  if (fileTarget.ok || fileTarget.status) return fileTarget;

  const siteTarget = normalizeSessionSyncAliasTarget(normalized, 'site:', 'NARADA_SITE_ROOT');
  if (siteTarget.ok || siteTarget.status) return siteTarget;

  const cloudTarget = normalizeSessionSyncAliasTarget(normalized, 'cloud:', 'NARADA_CLOUD_ROOT');
  if (cloudTarget.ok || cloudTarget.status) return cloudTarget;

  if (isLikelyPathLike(normalized)) {
    return {
      ok: true,
      scheme: 'path',
      siteRoot: resolve(normalized),
      alias: null,
    };
  }

  return {
    ok: false,
    status: 'invalid_session_sync_target',
    message: `Unrecognized --session-sync-target "${normalized}". Use a local path, file:// URL, site:<alias>, or cloud:<alias>.`,
  };
}

function normalizeSessionSyncAliasTarget(value, prefix, envPrefix) {
  const lowerPrefix = prefix.toLowerCase();
  if (!value.toLowerCase().startsWith(lowerPrefix)) return { ok: false };
  const alias = value.slice(prefix.length).trim();
  if (!alias) {
    return {
      ok: false,
      status: 'invalid_session_sync_target',
      message: `Unrecognized ${prefix} alias in --session-sync-target "${value}".`,
    };
  }
  const envKey = `${envPrefix}_${normalizeSessionSyncAlias(alias)}`;
  const aliasRoot = process.env[envKey];
  if (!aliasRoot || !String(aliasRoot).trim()) {
    return {
      ok: false,
      status: 'unresolved_session_sync_alias',
      message: `Cannot resolve --session-sync-target "${value}". Missing ${envKey}.`,
    };
  }
  return {
    ok: true,
    scheme: prefix.slice(0, -1),
    alias,
    siteRoot: resolve(String(aliasRoot)),
  };
}

function normalizeSessionSyncFileTarget(value) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return { ok: false };
  try {
    const siteRoot = resolve(fileURLToPath(new URL(value)));
    return { ok: true, scheme: 'file', alias: null, siteRoot };
  } catch {
    return {
      ok: false,
      status: 'invalid_session_sync_target',
      message: `Invalid file URI in --session-sync-target "${value}".`,
    };
  }
}

function normalizeSessionSyncAlias(alias) {
  return String(alias)
    .trim()
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toUpperCase();
}

function isLikelyPathLike(value) {
  const trimmed = String(value).trim();
  if (!trimmed) return false;
  if (trimmed === '.' || trimmed === '..') return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\\\') || trimmed.startsWith('./') || trimmed.startsWith('.\\\\')) return true;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\\\')) return true;
  if (/^[^:]+$/.test(trimmed)) return true;
  return false;
}

function cleanupSessionSyncStagingDirectories(...roots) {
  for (const root of roots) {
    const sourceStaging = join(root.sessionDir, '.session-sync-staging');
    const carrierStaging = join(root.carrierDir, '.session-sync-staging');
    const stale = [sourceStaging, carrierStaging];
    for (const directory of stale) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Ignore best-effort staging cleanup.
      }
    }
  }
}

function runSessionSyncDirection({ direction, source, destination, dryRun = false, deleteMissing = false }) {
  if (direction === 'download') {
    return copySessionSyncRoots({
      source: destination,
      destination: source,
      dryRun,
      deleteMissing: false,
      direction,
      compare: false,
      operation: 'download',
    });
  }
  if (direction === 'bidirectional') {
    const forward = copySessionSyncRoots({
      source,
      destination,
      direction,
      compare: true,
      dryRun,
      deleteMissing,
      operation: 'bidirectional',
    });
    const backward = copySessionSyncRoots({
      source: destination,
      destination: source,
      dryRun,
      deleteMissing,
      direction,
      compare: true,
      operation: 'bidirectional',
    });
    return {
      operation: 'bidirectional',
      success: forward.success && backward.success,
      copied: forward.copied + backward.copied,
      skipped: forward.skipped + backward.skipped,
      conflicts: forward.conflicts + backward.conflicts,
      message: forward.conflicts + backward.conflicts > 0 ? 'sync completed with conflict timestamps' : 'ok',
      carrierCopied: forward.carrierCopied + backward.carrierCopied,
      carrierSkipped: forward.carrierSkipped + backward.carrierSkipped,
      carrierConflicts: forward.carrierConflicts + backward.carrierConflicts,
      sessionCopied: forward.sessionCopied + backward.sessionCopied,
      sessionSkipped: forward.sessionSkipped + backward.sessionSkipped,
      sessionConflicts: forward.sessionConflicts + backward.sessionConflicts,
      direction,
    };
  }
  return copySessionSyncRoots({
    source,
    destination,
    direction,
    compare: false,
    deleteMissing: direction === 'upload' ? deleteMissing : false,
    dryRun,
    operation: 'upload',
  });
}

function copySessionSyncRoots({ source, destination, direction, compare, operation, dryRun = false, deleteMissing = false }) {
  const sourceSessionEntries = collectSessionRootEntries(source.sessionDir);
  const destinationSessionEntries = collectSessionRootEntries(destination.sessionDir);
  const sourceCarrierEntries = collectSessionRootEntries(source.carrierDir);
  const destinationCarrierEntries = collectSessionRootEntries(destination.carrierDir);

  const syncSession = copySessionSyncEntries({
    sourceRoot: source.sessionDir,
    destinationRoot: destination.sessionDir,
    sourceEntries: sourceSessionEntries,
    destinationEntries: destinationSessionEntries,
    compare,
    dryRun,
    deleteMissing,
    operation,
  });
  const syncCarrier = copySessionSyncEntries({
    sourceRoot: source.carrierDir,
    destinationRoot: destination.carrierDir,
    sourceEntries: sourceCarrierEntries,
    destinationEntries: destinationCarrierEntries,
    compare,
    dryRun,
    deleteMissing,
    operation,
  });

  return {
    operation,
    success: syncSession.conflicts === 0 && syncCarrier.conflicts === 0,
    copied: syncSession.copied + syncCarrier.copied,
    skipped: syncSession.skipped + syncCarrier.skipped,
    conflicts: syncSession.conflicts + syncCarrier.conflicts,
    deleted: syncSession.deleted + syncCarrier.deleted,
    message: syncSession.conflicts + syncCarrier.conflicts > 0 ? 'sync completed with conflict timestamps' : 'ok',
    carrierCopied: syncCarrier.copied,
    carrierSkipped: syncCarrier.skipped,
    carrierConflicts: syncCarrier.conflicts,
    carrierDeleted: syncCarrier.deleted,
    sessionCopied: syncSession.copied,
    sessionSkipped: syncSession.skipped,
    sessionConflicts: syncSession.conflicts,
    sessionDeleted: syncSession.deleted,
    direction,
  };
}

function copySessionSyncEntries({
  sourceRoot,
  destinationRoot,
  sourceEntries,
  destinationEntries,
  compare,
  dryRun = false,
  deleteMissing = false,
}) {
  if (!existsSync(sourceRoot)) sourceRoot = null;
  if (!sourceRoot) {
    return { copied: 0, skipped: 0, conflicts: 1, deleted: 0 };
  }

  const destinationByPath = new Map(destinationEntries.map((entry) => [entry.relativePath, entry]));
  let copied = 0;
  let skipped = 0;
  let conflicts = 0;
  let deleted = 0;

  for (const sourceEntry of sourceEntries) {
    const destinationEntry = destinationByPath.get(sourceEntry.relativePath);
    if (!destinationEntry) {
      if (!dryRun) {
        writeSessionSyncFile({ sourceEntry, destinationRoot });
      }
      copied += 1;
      continue;
    }
    if (!compare) {
      if (!dryRun) {
        writeSessionSyncFile({ sourceEntry, destinationRoot });
      }
      copied += 1;
      continue;
    }
    if (Number(sourceEntry.mtimeMs) > Number(destinationEntry.mtimeMs)) {
      if (!dryRun) {
        writeSessionSyncFile({ sourceEntry, destinationRoot });
      }
      copied += 1;
      continue;
    }
    if (Number(sourceEntry.mtimeMs) < Number(destinationEntry.mtimeMs)) {
      copied += 0;
      skipped += 1;
      continue;
    }
    if (sourceEntry.size === destinationEntry.size && sourceAndDestinationSessionSyncEntriesMatch({ sourceEntry, destinationEntry, destinationRoot })) {
      skipped += 1;
      continue;
    }
    conflicts += 1;
    if (!dryRun) {
      writeSessionSyncFile({ sourceEntry, destinationRoot });
    }
    copied += 1;
  }
  if (deleteMissing) {
    const sourcePaths = new Set(sourceEntries.map((entry) => entry.relativePath));
    for (const destinationEntry of destinationEntries) {
      if (sourcePaths.has(destinationEntry.relativePath)) continue;
      deleted += 1;
      if (!dryRun) {
        const destinationPath = join(destinationRoot, destinationEntry.relativePath);
        try {
          unlinkSync(destinationPath);
        } catch {
          // Ignore best-effort deletion failures.
        }
      }
    }
  }

  return { copied, skipped, conflicts, deleted };
}

function writeSessionSyncFile({ sourceEntry, destinationRoot }) {
  const destinationPath = join(destinationRoot, sourceEntry.relativePath);
  const destinationDirectory = dirname(destinationPath);
  const stagingDirectory = join(destinationRoot, '.session-sync-staging');
  const stagingPath = join(stagingDirectory, `${randomId()}.tmp`);
  let stagingFd = null;
  let destinationDirectoryFd = null;

  mkdirSync(destinationDirectory, { recursive: true });
  mkdirSync(stagingDirectory, { recursive: true });

  try {
    copyFileSync(sourceEntry.sourcePath, stagingPath);
    stagingFd = openSync(stagingPath, 'r');
    try {
      fsyncSync(stagingFd);
    } catch {
      // fsync can be unsupported for some Windows/FS combinations; continue without strict durability.
    }
    closeSync(stagingFd);
    stagingFd = null;
    try {
      renameSync(stagingPath, destinationPath);
    } catch (error) {
      if (error.code === 'EXDEV') {
        copyFileSync(stagingPath, destinationPath);
      } else {
        throw error;
      }
    }
    destinationDirectoryFd = openSync(destinationDirectory, 'r');
    try {
      fsyncSync(destinationDirectoryFd);
    } catch {
      // Directory fsync is best-effort for cross-platform compatibility.
    }
  } catch (error) {
    try {
      unlinkSync(stagingPath);
    } catch {
      // Ignore cleanup failures after write errors.
    }
    throw error;
  } finally {
    if (stagingFd !== null) {
      closeSync(stagingFd);
      stagingFd = null;
    }
    if (destinationDirectoryFd !== null) {
      closeSync(destinationDirectoryFd);
      destinationDirectoryFd = null;
    }
  }
}

function sourceAndDestinationSessionSyncEntriesMatch({ sourceEntry, destinationEntry, destinationRoot }) {
  const destinationPath = join(destinationRoot, sourceEntry.relativePath);
  if (!existsSync(destinationPath)) return false;
  if (Number(destinationEntry.size ?? 0) !== Number(sourceEntry.size)) return false;
  const sourceHash = sessionSyncSha256(sourceEntry.sourcePath);
  const destinationHash = sessionSyncSha256(destinationPath);
  if (!sourceHash || !destinationHash) return false;
  return sourceHash === destinationHash;
}

function sessionSyncSha256(filePath) {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function collectSessionRootEntries(root) {
  const entries = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) return entries;
  const visit = (current, relativePath = '') => {
    for (const dirEntry of readdirSync(current, { withFileTypes: true })) {
      const nextPath = join(current, dirEntry.name);
      const nextRelative = relativePath ? join(relativePath, dirEntry.name) : dirEntry.name;
      if (dirEntry.isDirectory()) {
        visit(nextPath, nextRelative);
      } else if (dirEntry.isFile()) {
        const stat = statSync(nextPath);
        entries.push({
          relativePath: nextRelative,
          sourcePath: nextPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  };
  visit(root);
  return entries;
}

function resolveSessionSyncDirectoryRoots({ siteRoot, session, naradaDir = NARADA_DIR } = {}) {
  const normalizedSiteRoot = resolve(siteRoot);
  // Legacy sync/import compatibility only. Active runtime sessions live under
  // .narada/crew/nars-sessions/<session>/session.jsonl.
  const legacyAgentSessionsRoot = existsSync(join(normalizedSiteRoot, 'agent-sessions'))
    ? join(normalizedSiteRoot, 'agent-sessions')
    : (existsSync(join(normalizedSiteRoot, '.ai', 'runtime', 'agent-sessions'))
      ? join(normalizedSiteRoot, '.ai', 'runtime', 'agent-sessions')
      : join(normalizedSiteRoot, 'agent-sessions'));

  const carrierSessionRoot = existsSync(join(normalizedSiteRoot, '.narada', 'crew', 'nars-sessions', session))
    ? join(normalizedSiteRoot, '.narada', 'crew', 'nars-sessions', session)
    : join(normalizedSiteRoot, 'crew', 'nars-sessions', session);

  if (existsSync(join(normalizedSiteRoot, 'nars-sessions', session))) {
    return {
      siteRoot: normalizedSiteRoot,
      sessionDir: legacyAgentSessionsRoot,
      carrierDir: join(normalizedSiteRoot, 'nars-sessions', session),
      naradaDir,
      hasCarrierDir: true,
    };
  }
  if (existsSync(join(normalizedSiteRoot, 'agent-sessions', `${session}.jsonl`))) {
    return {
      siteRoot: normalizedSiteRoot,
      sessionDir: legacyAgentSessionsRoot,
      carrierDir: join(normalizedSiteRoot, '.narada', 'crew', 'nars-sessions', session),
      naradaDir,
      hasCarrierDir: true,
    };
  }
  return {
    siteRoot: normalizedSiteRoot,
    sessionDir: legacyAgentSessionsRoot,
    carrierDir: carrierSessionRoot,
    naradaDir,
    hasCarrierDir: true,
  };
}

async function runSessionRead({ session = SESSION, siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false } = {}) {
  const sessionRecord = readPersistedSession({ session, siteRoot, naradaDir });
  if (!sessionRecord) {
    if (jsonOutput) {
      console.log(`${JSON.stringify({
        schema: 'narada.agent_cli.session_read.v1',
        site_root: siteRoot,
        session,
        found: false,
      }, null, 2)}\n`);
    } else {
      console.log(formatKeyValueRows({
        SiteRoot: siteRoot,
        Session: session,
        Status: 'persisted session not found',
      }));
    }
    return 0;
  }
  const sessionEventSummary = createSessionEventSummaryPayload(sessionRecord, { naradaDir, eventFilter: 'all', recentCount: 20 });
  const sessionOperationPayload = createSessionOperationPayload(sessionRecord);
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_read.v1',
      site_root: siteRoot,
      session,
      found: true,
      operation: sessionOperationPayload,
      recovery: createSessionRecoveryPayload(sessionRecord),
      preflight: createSessionPreflightPayload(sessionRecord),
      host_command_output: createSessionHostCommandOutputPayload(sessionRecord),
      event_summary: sessionEventSummary,
      record: sessionRecord,
    }, null, 2)}\n`);
    return 0;
  }
  console.log(formatKeyValueRows({
    SiteRoot: siteRoot,
    Session: sessionRecord.session,
    Agent: sessionRecord.agent_id ?? 'unknown',
    Runtime: sessionRecord.runtime ?? 'unknown',
    Mode: sessionRecord.mode ?? 'unknown',
    Started: sessionRecord.started_at ?? 'unknown',
    Heartbeat: sessionRecord.heartbeat_display,
    'Operational posture': sessionRecord.operational_posture_display,
    'MCP state': sessionRecord.mcp_operational_state,
    'Request posture': sessionRecord.request_posture_display,
    'Operation events': sessionOperationPayload.operation_event_summary,
    'Directive kinds': sessionOperationPayload.directive_kind_summary,
    'Directive visibility': sessionOperationPayload.directive_visibility_summary,
    'Operation ids': sessionOperationPayload.operation_id_summary,
    'Last operation id': sessionOperationPayload.last_operation_id ?? 'none',
    'Last directive kind': sessionOperationPayload.last_directive_kind ?? 'none',
    'Last directive visibility': sessionOperationPayload.last_directive_visibility ?? 'none',
    'Last operation event': sessionOperationPayload.last_operation_event_kind ?? 'none',
    'Last operation at': sessionOperationPayload.last_operation_at ?? 'unknown',
    'Last event': sessionRecord.last_event_kind ?? 'none',
    'Last event at': sessionRecord.last_event_at ?? 'unknown',
    'Last terminal state': sessionRecord.last_terminal_state ?? 'none',
    'Last lifecycle event': sessionRecord.last_lifecycle_event_kind ?? 'none',
    'Last lifecycle at': sessionRecord.last_lifecycle_at ?? 'unknown',
    'Last lifecycle state': sessionRecord.last_lifecycle_state ?? 'none',
    'Lifecycle outcomes': sessionRecord.lifecycle_state_summary,
    'Request outcomes': sessionRecord.request_outcome_summary,
    'Request issues': sessionRecord.request_issue_summary,
    'Host command states': sessionRecord.host_command_terminal_state_summary,
    'Last host command': sessionRecord.last_host_command_summary ?? 'none',
    'Last host command state': sessionRecord.last_host_command_terminal_state ?? 'none',
    'Last host command output': sessionRecord.last_host_command_output_ref ?? 'none',
    'Host command output review': sessionRecord?.handoffs?.host_command_output_read ?? 'none',
    'Event count': sessionEventSummary.event_count,
    'Event kinds': sessionEventSummary.event_kind_summary,
    'Issue codes': sessionEventSummary.issue_code_summary,
    'Terminal states': sessionEventSummary.terminal_state_summary,
    'MCP startup failures': sessionRecord.mcp_startup_failure_summary,
    'MCP runtime faults': sessionRecord.mcp_runtime_fault_summary,
    'Preflight artifact': sessionRecord.mcp_preflight_artifact_path ?? 'none',
    'Preflight state': sessionRecord.mcp_preflight_operational_state ?? 'none',
    'Preflight action': sessionRecord.mcp_preflight_recommended_action_display ?? 'none',
    'Preflight command': sessionRecord.mcp_preflight_recommended_command ?? 'none',
    'Preflight diagnostics': sessionRecord?.mcp_preflight_handoffs?.mcp_preflight_diagnostics ?? 'none',
    'Session operations': sessionOperationPayload.handoffs.session_operations ?? 'none',
    'Recovery kind': sessionRecord.recovery_kind_display ?? 'none',
    'Recovery primary': sessionRecord.recovery_primary_command ?? 'none',
    'Recovery followup': sessionRecord.recovery_followup_command ?? 'none',
    'Recommended action': sessionRecord.recommended_action_display,
    'Recommended command': sessionRecord.recommended_command ?? 'none',
    'Session recovery': sessionRecord?.handoffs?.session_recovery ?? 'none',
    'Session events': sessionRecord?.handoffs?.session_events ?? 'none',
    'Session issues': sessionRecord?.handoffs?.session_events_issues ?? 'none',
    'Session diagnostics': sessionRecord?.handoffs?.session_events_diagnostics ?? 'none',
    'Host command output review': sessionRecord?.handoffs?.host_command_output_read ?? 'none',
    'Session path': sessionRecord.session_path,
  }));
  return 0;
}

function readSessionInventory({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR } = {}) {
  const sessionsRoot = join(naradaDir, 'crew', 'nars-sessions');
  return readDirFiles(sessionsRoot)
    .map((session) => readPersistedSession({ session, siteRoot, naradaDir }))
    .filter(Boolean)
    .sort((left, right) => String(right?.heartbeat_at ?? '').localeCompare(String(left?.heartbeat_at ?? '')) || left.session.localeCompare(right.session));
}

function readPersistedSession({ session = SESSION, siteRoot = SITE_ROOT, naradaDir = NARADA_DIR } = {}) {
  const sessionDir = join(naradaDir, 'crew', 'nars-sessions', session);
  try {
    if (!statSync(sessionDir).isDirectory()) return null;
  } catch {
    return null;
  }
  return summarizePersistedSession({ session, sessionDir, siteRoot, naradaDir });
}

function readPersistedSessionEvents({ session = SESSION, naradaDir = NARADA_DIR } = {}) {
  const sessionDir = join(naradaDir, 'crew', 'nars-sessions', session);
  try {
    if (!statSync(sessionDir).isDirectory()) return [];
  } catch {
    return [];
  }
  return readJsonlFile(join(sessionDir, 'session.jsonl'));
}

function normalizeSessionEventsFilter(value) {
  const normalized = String(value ?? 'all').trim().toLowerCase();
  if (['all', 'lifecycle', 'issues', 'diagnostics', 'operations'].includes(normalized)) return normalized;
  return 'all';
}

function normalizeSessionSyncDirection(value) {
  const normalized = String(value ?? 'upload').trim().toLowerCase();
  if (['upload', 'download', 'bidirectional'].includes(normalized)) return normalized;
  return 'upload';
}

function filterPersistedSessionEvents(events = [], { eventFilter = 'all' } = {}) {
  const normalizedEventFilter = normalizeSessionEventsFilter(eventFilter);
  if (normalizedEventFilter === 'all') return events;
  return events.filter((entry) => {
    if (normalizedEventFilter === 'lifecycle') return classifyPersistedSessionLifecycleState(entry) !== null;
    if (normalizedEventFilter === 'issues') return classifyPersistedSessionIssueCode(entry) !== null;
    if (normalizedEventFilter === 'diagnostics') return (entry?.event_kind ?? entry?.event ?? null) === 'carrier_diagnostic_recorded';
    if (normalizedEventFilter === 'operations') return classifyPersistedSessionOperationEvent(entry) !== null;
    return true;
  });
}

function summarizeSessionInventoryEvents(inventory = [], { naradaDir = NARADA_DIR, eventFilter = 'all', recentCount = 20 } = {}) {
  const normalizedEventFilter = normalizeSessionEventsFilter(eventFilter);
  const eventKindCounts = {};
  const issueCodeCounts = {};
  const terminalStateCounts = {};
  const sessions = [];
  const recentEvents = [];
  for (const item of inventory) {
    const session = item?.session;
    if (!session) continue;
    const events = filterPersistedSessionEvents(readPersistedSessionEvents({ session, naradaDir }), { eventFilter: normalizedEventFilter });
    if (events.length === 0) continue;
    for (const entry of events) {
      const eventKind = entry?.event_kind ?? entry?.event ?? 'unknown-event';
      const terminalState = entry?.payload?.terminal_state ?? entry?.terminal_state ?? null;
      const issueCode = classifyPersistedSessionIssueCode(entry);
      incrementInventoryCounter(eventKindCounts, eventKind);
      if (terminalState) incrementInventoryCounter(terminalStateCounts, terminalState);
      if (issueCode) incrementInventoryCounter(issueCodeCounts, issueCode);
      recentEvents.push({
        session,
        timestamp: entry?.timestamp ?? entry?.occurred_at ?? entry?.payload?.occurred_at ?? entry?.payload?.created_at ?? 'unknown-time',
        event_kind: eventKind,
        terminal_state: terminalState,
        issue_code: issueCode,
      });
    }
    const lastEvent = events.at(-1) ?? null;
    sessions.push({
      session,
      event_count: events.length,
      last_event_kind: lastEvent?.event_kind ?? lastEvent?.event ?? 'unknown-event',
      last_event_at: lastEvent?.timestamp ?? lastEvent?.occurred_at ?? lastEvent?.payload?.occurred_at ?? lastEvent?.payload?.created_at ?? 'unknown-time',
      recommended_action: item?.recommended_action,
      recommended_action_display: item?.recommended_action_display,
      recommended_command: item?.recommended_command ?? null,
      recovery_kind: item?.recovery_kind ?? null,
      recovery_kind_display: item?.recovery_kind_display ?? null,
      recovery_primary_command: item?.recovery_primary_command ?? null,
      recovery_followup_command: item?.recovery_followup_command ?? null,
      handoffs: item?.handoffs ?? buildPersistedSessionHandoffs({ session, identity: item?.agent_id ?? IDENTITY, eventCount: recentCount }),
    });
  }
  sessions.sort((left, right) => right.event_count - left.event_count || String(right.last_event_at ?? '').localeCompare(String(left.last_event_at ?? '')) || left.session.localeCompare(right.session));
  recentEvents.sort((left, right) => String(right.timestamp ?? '').localeCompare(String(left.timestamp ?? '')) || left.session.localeCompare(right.session) || left.event_kind.localeCompare(right.event_kind));
  const workflowGroups = summarizeActionWorkflowGroups(sessions);
  return {
    event_filter: normalizedEventFilter,
    event_count: recentEvents.length,
    event_kind_counts: eventKindCounts,
    event_kind_summary: formatInventoryCounts(eventKindCounts),
    issue_code_counts: issueCodeCounts,
    issue_code_summary: formatInventoryCounts(issueCodeCounts),
    terminal_state_counts: terminalStateCounts,
    terminal_state_summary: formatInventoryCounts(terminalStateCounts),
    recommended_action_counts: workflowGroups ? Object.fromEntries(Object.entries(workflowGroups).map(([key, group]) => [key, Array.isArray(group?.sessions) ? group.sessions.length : 0])) : {},
    recommended_action_summary: formatInventoryCounts(workflowGroups ? Object.fromEntries(Object.entries(workflowGroups).map(([key, group]) => [key, Array.isArray(group?.sessions) ? group.sessions.length : 0])) : {}),
    recommended_command_counts: sessions.reduce((counts, item) => (incrementInventoryCounter(counts, item?.recommended_command ?? 'none'), counts), {}),
    recommended_command_summary: formatInventoryCounts(sessions.reduce((counts, item) => (incrementInventoryCounter(counts, item?.recommended_command ?? 'none'), counts), {})),
    recovery_primary_counts: sessions.reduce((counts, item) => (incrementInventoryCounter(counts, item?.recovery_primary_command ?? 'none'), counts), {}),
    recovery_primary_summary: formatInventoryCounts(sessions.reduce((counts, item) => (incrementInventoryCounter(counts, item?.recovery_primary_command ?? 'none'), counts), {})),
    recovery_followup_counts: sessions.reduce((counts, item) => (incrementInventoryCounter(counts, item?.recovery_followup_command ?? 'none'), counts), {}),
    recovery_followup_summary: formatInventoryCounts(sessions.reduce((counts, item) => (incrementInventoryCounter(counts, item?.recovery_followup_command ?? 'none'), counts), {})),
    groups: summarizeSessionInventoryEventGroups(recentEvents),
    workflow_groups: workflowGroups,
    sessions,
    recent_events: recentEvents.slice(0, recentCount),
  };
}

function summarizeSessionInventoryEventGroups(events = []) {
  return {
    event_kind: summarizeSessionInventoryEventGroupBy(events, (entry) => entry?.event_kind ?? 'unknown-event'),
    issue_code: summarizeSessionInventoryEventGroupBy(events.filter((entry) => entry?.issue_code), (entry) => entry.issue_code),
    terminal_state: summarizeSessionInventoryEventGroupBy(events.filter((entry) => entry?.terminal_state), (entry) => entry.terminal_state),
  };
}

function summarizeSessionInventoryEventGroupBy(events = [], getKey) {
  const groups = Object.create(null);
  for (const entry of events) {
    const key = String(getKey(entry) ?? 'unknown');
    if (!groups[key]) groups[key] = [];
    groups[key].push(entry);
  }
  return Object.fromEntries(Object.entries(groups)
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .map(([key, entries]) => [key, entries
      .slice()
      .sort((left, right) => String(right.timestamp ?? '').localeCompare(String(left.timestamp ?? '')) || left.session.localeCompare(right.session) || left.event_kind.localeCompare(right.event_kind))]));
}

function normalizeSessionInventoryFilterKey(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['operational_posture', 'request_posture', 'mcp_state', 'heartbeat_status', 'recommended_action', 'recovery_kind'].includes(normalized)) return normalized;
  return null;
}

function normalizeSessionInventoryFilterValue(value) {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 ? normalized : null;
}

function filterSessionInventory(inventory = [], { filterKey = null, filterValue = null } = {}) {
  const normalizedFilterKey = normalizeSessionInventoryFilterKey(filterKey);
  const normalizedFilterValue = normalizeSessionInventoryFilterValue(filterValue);
  if (!normalizedFilterKey || !normalizedFilterValue) return inventory;
  const fieldByFilterKey = {
    operational_posture: 'operational_posture',
    request_posture: 'request_posture',
    mcp_state: 'mcp_operational_state',
    heartbeat_status: 'heartbeat_status',
    recommended_action: 'recommended_action',
    recovery_kind: 'recovery_kind',
  };
  const field = fieldByFilterKey[normalizedFilterKey];
  return inventory.filter((item) => String(item?.[field] ?? '') === normalizedFilterValue);
}

function summarizeSessionInventoryRollup(inventory = []) {
  const heartbeatCounts = {};
  const operationalPostureCounts = {};
  const mcpStateCounts = {};
  const terminalStateCounts = {};
  const lifecycleStateCounts = {};
  const lifecycleOutcomeCounts = {};
  const requestPostureCounts = {};
  const requestOutcomeCounts = {};
  const requestIssueCounts = {};
  const hostCommandTerminalStateCounts = {};
  for (const item of inventory) {
    incrementInventoryCounter(heartbeatCounts, item?.heartbeat_status ?? 'unknown');
    incrementInventoryCounter(operationalPostureCounts, item?.operational_posture ?? 'unknown');
    incrementInventoryCounter(mcpStateCounts, item?.mcp_operational_state ?? 'unknown');
    incrementInventoryCounter(terminalStateCounts, item?.last_terminal_state ?? 'unknown');
    incrementInventoryCounter(lifecycleStateCounts, item?.last_lifecycle_state ?? 'unknown');
    incrementInventoryCounter(requestPostureCounts, item?.request_posture ?? 'clean');
    mergeInventoryCounts(lifecycleOutcomeCounts, item?.lifecycle_state_counts ?? null);
    mergeInventoryCounts(requestOutcomeCounts, item?.request_outcome_counts ?? null);
    mergeInventoryCounts(requestIssueCounts, item?.request_issue_counts ?? null);
    mergeInventoryCounts(hostCommandTerminalStateCounts, item?.host_command_terminal_state_counts ?? null);
  }
  return {
    heartbeat_status_counts: heartbeatCounts,
    heartbeat_status_summary: formatInventoryCounts(heartbeatCounts),
    operational_posture_counts: operationalPostureCounts,
    operational_posture_summary: formatInventoryCounts(operationalPostureCounts),
    mcp_operational_state_counts: mcpStateCounts,
    mcp_operational_state_summary: formatInventoryCounts(mcpStateCounts),
    last_terminal_state_counts: terminalStateCounts,
    last_terminal_state_summary: formatInventoryCounts(terminalStateCounts),
    last_lifecycle_state_counts: lifecycleStateCounts,
    last_lifecycle_state_summary: formatInventoryCounts(lifecycleStateCounts),
    lifecycle_outcome_counts: lifecycleOutcomeCounts,
    lifecycle_outcome_summary: formatInventoryCounts(lifecycleOutcomeCounts),
    request_posture_counts: requestPostureCounts,
    request_posture_summary: formatInventoryCounts(requestPostureCounts),
    request_outcome_counts: requestOutcomeCounts,
    request_outcome_summary: formatInventoryCounts(requestOutcomeCounts),
    request_issue_counts: requestIssueCounts,
    request_issue_summary: formatInventoryCounts(requestIssueCounts),
    host_command_terminal_state_counts: hostCommandTerminalStateCounts,
    host_command_terminal_state_summary: formatInventoryCounts(hostCommandTerminalStateCounts),
  };
}

function incrementInventoryCounter(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function mergeInventoryCounts(targetCounts, sourceCounts) {
  if (!sourceCounts || typeof sourceCounts !== 'object') return;
  for (const [key, count] of Object.entries(sourceCounts)) {
    targetCounts[key] = (targetCounts[key] ?? 0) + Number(count ?? 0);
  }
}

function formatInventoryCounts(counts) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return '0';
  return entries
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, count]) => `${count} (${key})`)
    .join(', ');
}

function summarizePersistedHostCommandLifecycle(entries = []) {
  const hostCommandEventCounts = {};
  const hostCommandTerminalStateCounts = {};
  let lastHostCommand = null;
  for (const entry of entries) {
    const eventKind = entry?.event_kind ?? entry?.event ?? null;
    if (!String(eventKind ?? '').startsWith('carrier_host_command_')) continue;
    incrementInventoryCounter(hostCommandEventCounts, eventKind);
    const payload = entry?.payload ?? {};
    const terminalState = payload.terminal_state ?? null;
    if (terminalState) incrementInventoryCounter(hostCommandTerminalStateCounts, terminalState);
    if (!payload.command_id) continue;
    const occurredAt = entry?.timestamp ?? entry?.occurred_at ?? payload?.occurred_at ?? payload?.created_at ?? null;
    const candidate = {
      command_id: payload.command_id,
      command_summary: payload.command_summary ?? payload.command_text ?? null,
      terminal_state: terminalState,
      output_ref: payload?.output_ref?.payload_ref ?? null,
      output_reader_tool: payload?.output_ref?.reader_tool ?? null,
      event_kind: eventKind,
      occurred_at: occurredAt,
    };
    if (!lastHostCommand || String(candidate.occurred_at ?? '').localeCompare(String(lastHostCommand.occurred_at ?? '')) >= 0) {
      lastHostCommand = candidate;
    }
  }
  return {
    host_command_event_count: Object.values(hostCommandEventCounts).reduce((sum, count) => sum + Number(count ?? 0), 0),
    host_command_event_counts: hostCommandEventCounts,
    host_command_event_summary: formatInventoryCounts(hostCommandEventCounts),
    host_command_terminal_state_counts: hostCommandTerminalStateCounts,
    host_command_terminal_state_summary: formatInventoryCounts(hostCommandTerminalStateCounts),
    last_host_command_id: lastHostCommand?.command_id ?? null,
    last_host_command_summary: lastHostCommand?.command_summary ?? null,
    last_host_command_terminal_state: lastHostCommand?.terminal_state ?? null,
    last_host_command_output_ref: lastHostCommand?.output_ref ?? null,
    last_host_command_output_reader_tool: lastHostCommand?.output_reader_tool ?? null,
    last_host_command_event_kind: lastHostCommand?.event_kind ?? null,
    last_host_command_at: lastHostCommand?.occurred_at ?? null,
  };
}

function summarizePersistedOperationLifecycle(entries = []) {
  const operationEventCounts = {};
  const directiveKindCounts = {};
  const directiveVisibilityCounts = {};
  const operationIdCounts = {};
  const operationMetadataById = Object.create(null);
  const visibilityValuesByLifecycleKey = Object.create(null);
  const fallbackOperationIdCandidates = new Set();
  let lastOperation = null;

  const looksLikeOperationId = (value) => (
    typeof value === 'string' && /^operation_[A-Za-z0-9_]+$/.test(value)
      ? value
      : null
  );

  const findOperationIdInObject = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 4) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = findOperationIdInObject(item, depth + 1);
        if (nested) return nested;
      }
      return null;
    }
    const objectKind = value?.kind;
    if (objectKind === 'operation' && typeof value?.id === 'string') {
      const candidate = looksLikeOperationId(value.id);
      if (candidate) return candidate;
    }
    for (const [key, candidateValue] of Object.entries(value)) {
      if (key === 'operation_id' || key === 'operationId') {
        const explicitCandidate = looksLikeOperationId(candidateValue);
        if (explicitCandidate) return explicitCandidate;
      }
      const nested = findOperationIdInObject(candidateValue, depth + 1);
      if (nested) return nested;
    }
    return null;
  };

  const targetOperationId = (target) => {
    if (!target || typeof target !== 'object') return null;
    return target.kind === 'operation' ? target.id : null;
  };

  const targetCarrierSessionId = (target) => {
    if (!target || typeof target !== 'object') return null;
    return target.kind === 'carrier_session' ? target.id : null;
  };

  const extractOperationId = (payload, entry) => {
    const operationId = (
      payload?.operation_id
      ?? payload?.operationId
      ?? payload?.operation?.id
      ?? payload?.directive?.operation_id
      ?? payload?.directive?.operationId
      ?? payload?.directive?.operation?.id
      ?? payload?.authorization?.operation_id
      ?? payload?.authorization?.operationId
      ?? payload?.authorization?.operation?.id
      ?? payload?.rule?.operation_id
      ?? payload?.rule?.operationId
      ?? payload?.rule?.operation?.id
      ?? payload?.input?.operation_id
      ?? payload?.input?.operationId
      ?? payload?.input?.operation?.id
      ?? targetOperationId(payload?.target)
      ?? targetOperationId(payload?.authorization?.target)
      ?? targetOperationId(payload?.rule?.target)
      ?? targetOperationId(payload?.input?.target)
      ?? (entry?.operation?.id)
      ?? entry?.operationId
      ?? entry?.operation_id
      ?? entry?.metadata?.operation_id
      ?? entry?.metadata?.operationId
      ?? entry?.metadata?.operation?.id
      ?? payload?.operation_inventory_id
      ?? payload?.operationInventoryId
      ?? (entry?.event === 'directive_emitted'
        ? payload?.authorization?.operation_id
        : null)
      ?? findOperationIdInObject(entry, 0)
      ?? findOperationIdInObject(payload, 0)
    );
    if (operationId) {
      const candidate = looksLikeOperationId(operationId);
      if (candidate) fallbackOperationIdCandidates.add(candidate);
      return operationId;
    }
    const payloadOperationInventory = looksLikeOperationId(payload?.operation_id);
    if (payloadOperationInventory) {
      fallbackOperationIdCandidates.add(payloadOperationInventory);
      return payloadOperationInventory;
    }
    const metadataOperationInventory = looksLikeOperationId(entry?.metadata?.operation_id);
    if (metadataOperationInventory) {
      fallbackOperationIdCandidates.add(metadataOperationInventory);
      return metadataOperationInventory;
    }
    return null;
  };

  const extractDirectiveLifecycleKey = (payload, entry, operationId) => {
    const targetSessionId = targetCarrierSessionId(payload?.target)
      ?? targetCarrierSessionId(payload?.authorization?.target)
      ?? targetCarrierSessionId(payload?.rule?.target)
      ?? targetCarrierSessionId(payload?.input?.target)
      ?? targetCarrierSessionId(entry?.target);
    if (operationId) return `operation:${operationId}`;
    if (targetSessionId) return `carrier_session:${targetSessionId}`;
    return null;
  };

  const recordVisibilityValue = (key, visibility) => {
    if (!key || !visibility) return;
    const current = visibilityValuesByLifecycleKey[key];
    if (!current) {
      visibilityValuesByLifecycleKey[key] = new Set([visibility]);
      return;
    }
    current.add(visibility);
  };

  const resolveVisibilityFromLifecycleKey = (key) => {
    const values = visibilityValuesByLifecycleKey[key];
    if (!values || values.size !== 1) return null;
    return Array.from(values)[0];
  };

  const extractDirectiveKind = (payload, entry) =>
    payload?.directive_kind
    ?? payload?.kind
    ?? payload?.directive?.kind
    ?? payload?.authorization?.directive_kind
    ?? payload?.authorization?.kind
    ?? payload?.rule?.directive_kind
    ?? payload?.rule?.kind
    ?? payload?.input?.directive_kind
    ?? payload?.input?.kind
    ?? entry?.metadata?.directive?.kind
    ?? null;

  const extractDirectiveVisibility = (payload, entry) =>
    payload?.visibility
    ?? payload?.directive_visibility
    ?? payload?.directive?.visibility
    ?? payload?.authorization?.visibility
    ?? payload?.rule?.visibility
    ?? payload?.input?.visibility
    ?? entry?.metadata?.directive?.visibility
    ?? null;

  for (const entry of entries) {
    const eventKind = entry?.event_kind ?? entry?.event ?? null;
    if (!['directive_emission_authorized', 'directive_emission_rule_recorded', 'directive_emitted'].includes(String(eventKind ?? ''))) {
      continue;
    }
    const payload = entry?.payload ?? {};
    const operationId = extractOperationId(payload, entry);
    const key = extractDirectiveLifecycleKey(payload, entry, operationId);
    const directiveKind = extractDirectiveKind(payload, entry);
    const directiveVisibility = extractDirectiveVisibility(payload, entry);
    if (directiveVisibility) {
      recordVisibilityValue(key, directiveVisibility);
    }
    if (!operationId || (!directiveKind && !directiveVisibility)) {
      continue;
    }
    const cachedMetadata = operationMetadataById[operationId] ?? {};
    operationMetadataById[operationId] = {
      ...cachedMetadata,
      kind: directiveKind ?? cachedMetadata.kind ?? null,
      visibility: directiveVisibility ?? cachedMetadata.visibility ?? null,
    };
  }

  let lastDirectiveKind = null;
  let lastDirectiveVisibility = null;
  const synthesizedOperationIdByKey = new Map();
  let synthesizedOperationIdCounter = 1;
  const operationIds = Object.keys(operationMetadataById);
  const candidateOperationIds = Array.from(fallbackOperationIdCandidates);
  const fallbackOperationId = operationIds.length === 1
    ? operationIds[0]
    : (candidateOperationIds.length === 1 ? candidateOperationIds[0] : null);
  const synthesizeOperationId = (lifecycleKey) => {
    if (!lifecycleKey) return null;
    if (!synthesizedOperationIdByKey.has(lifecycleKey)) {
      synthesizedOperationIdByKey.set(
        lifecycleKey,
        `operation_inventory_${synthesizedOperationIdCounter++}`,
      );
    }
    return synthesizedOperationIdByKey.get(lifecycleKey);
  };

  for (const entry of entries) {
    const eventKind = entry?.event_kind ?? entry?.event ?? null;
    if (!['directive_emission_authorized', 'directive_emission_rule_recorded', 'directive_emitted'].includes(String(eventKind ?? ''))) {
      continue;
    }
    incrementInventoryCounter(operationEventCounts, eventKind);
    const payload = entry?.payload ?? {};
    let operationId = extractOperationId(payload, entry) ?? fallbackOperationId;
    const key = extractDirectiveLifecycleKey(payload, entry, operationId);
    if (!operationId) operationId = synthesizeOperationId(key ?? 'default');
    const fallbackVisibilityFromLifecycle = key ? resolveVisibilityFromLifecycleKey(key) : null;
    const fallbackMetadata = operationId ? operationMetadataById[operationId] ?? {} : {};
    const resolvedDirectiveKind = extractDirectiveKind(payload, entry)
      ?? fallbackMetadata.kind
      ?? lastDirectiveKind
      ?? null;
    const resolvedDirectiveVisibility = extractDirectiveVisibility(payload, entry)
      ?? fallbackMetadata.visibility
      ?? fallbackVisibilityFromLifecycle
      ?? lastDirectiveVisibility
      ?? null;

    if (operationId && (resolvedDirectiveKind || resolvedDirectiveVisibility)) {
      const cachedMetadata = operationMetadataById[operationId] ?? {};
      operationMetadataById[operationId] = {
        ...cachedMetadata,
        kind: resolvedDirectiveKind ?? cachedMetadata.kind ?? null,
        visibility: resolvedDirectiveVisibility ?? cachedMetadata.visibility ?? null,
      };
    }

    if (resolvedDirectiveKind) incrementInventoryCounter(directiveKindCounts, resolvedDirectiveKind);
    if (resolvedDirectiveVisibility) incrementInventoryCounter(directiveVisibilityCounts, resolvedDirectiveVisibility);
    if (resolvedDirectiveKind) lastDirectiveKind = resolvedDirectiveKind;
    if (resolvedDirectiveVisibility) lastDirectiveVisibility = resolvedDirectiveVisibility;
    if (operationId) incrementInventoryCounter(operationIdCounts, operationId);

    const occurredAt = entry?.timestamp ?? entry?.occurred_at ?? payload?.occurred_at ?? payload?.created_at ?? null;
    const candidate = {
      operation_id: operationId,
      directive_kind: resolvedDirectiveKind,
      directive_visibility: resolvedDirectiveVisibility,
      event_kind: eventKind,
      occurred_at: occurredAt,
    };
    if (!lastOperation || String(candidate.occurred_at ?? '').localeCompare(String(lastOperation.occurred_at ?? '')) >= 0) {
      lastOperation = candidate;
    }
  }

  return {
    operation_event_count: Object.values(operationEventCounts).reduce((sum, count) => sum + Number(count ?? 0), 0),
    operation_event_counts: operationEventCounts,
    operation_event_summary: formatInventoryCounts(operationEventCounts),
    directive_kind_counts: directiveKindCounts,
    directive_kind_summary: formatInventoryCounts(directiveKindCounts),
    directive_visibility_counts: directiveVisibilityCounts,
    directive_visibility_summary: formatInventoryCounts(directiveVisibilityCounts),
    operation_id_counts: operationIdCounts,
    operation_id_summary: formatInventoryCounts(operationIdCounts),
    last_operation_id: lastOperation?.operation_id ?? null,
    last_directive_kind: lastOperation?.directive_kind ?? null,
    last_directive_visibility: lastOperation?.directive_visibility ?? null,
    last_operation_event_kind: lastOperation?.event_kind ?? null,
    last_operation_at: lastOperation?.occurred_at ?? null,
  };
}

function classifyPersistedSessionLifecycleState(entry) {
  const eventKind = entry?.event ?? entry?.event_kind ?? null;
  const terminalState = entry?.payload?.terminal_state ?? entry?.terminal_state ?? null;
  if (eventKind === 'session_closed') return terminalState ?? 'closed';
  if (eventKind === 'turn_failed') return terminalState ?? 'failed';
  if (eventKind === 'turn_complete') return terminalState ?? 'completed';
  if (eventKind === 'input_completed' || eventKind === 'input_event_completed') return terminalState ?? 'completed';
  if (eventKind === 'interactive_loop_error') return 'interactive_loop_error';
  return null;
}

function classifyPersistedSessionIssueCode(entry) {
  const eventKind = entry?.event ?? entry?.event_kind ?? null;
  if (eventKind === 'error') return entry?.code ?? entry?.payload?.code ?? 'error';
  if (eventKind === 'interactive_loop_error') return 'interactive_loop_error';
  return null;
}

function classifyPersistedSessionOperationEvent(entry) {
  const eventKind = entry?.event_kind ?? entry?.event ?? null;
  if (['directive_emission_authorized', 'directive_emission_rule_recorded', 'directive_emitted'].includes(String(eventKind ?? ''))) {
    return eventKind;
  }
  return null;
}

function classifySessionIssueOutcomeCode(issueCode) {
  const normalizedCode = String(issueCode ?? '');
  if (!normalizedCode) return null;
  if (normalizedCode === 'session_closed') return 'rejected_closed';
  if (normalizedCode === 'request_dispatch_failed') return 'dispatch_failure';
  if (normalizedCode === 'request_failed') return 'request_runtime_failure';
  if (normalizedCode === 'interactive_loop_error') return 'interactive_runtime_failure';
  if (
    normalizedCode === 'invalid_json'
    || normalizedCode === 'message_required'
    || normalizedCode === 'directive_message_required'
    || normalizedCode.startsWith('invalid_')
    || normalizedCode.startsWith('unsupported_')
    || normalizedCode.startsWith('unknown_')
    || normalizedCode.endsWith('_required')
  ) {
    return 'invalid_request';
  }
  return 'request_error';
}

function readMcpPreflightArtifact({ artifactDir, session = SESSION, identity = IDENTITY, siteRoot = SITE_ROOT } = {}) {
  if (!artifactDir) return null;
  const artifactPath = join(artifactDir, `${session}.json`);
  if (!existsSync(artifactPath)) return null;
  try {
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    if (artifact?.schema !== 'narada.agent_cli.mcp_preflight_artifact.v1') return null;
    if (artifact?.session !== session) return null;
    if (artifact?.identity !== identity) return null;
    if (artifact?.site_root !== siteRoot) return null;
    return summarizePersistedMcpPreflightArtifact({ artifact, artifactPath });
  } catch {
    return null;
  }
}

function summarizePersistedMcpPreflightArtifact({ artifact, artifactPath } = {}) {
  if (!artifact || artifact?.schema !== 'narada.agent_cli.mcp_preflight_artifact.v1') return null;
  const handoffs = buildMcpPreflightHandoffs({ session: artifact.session, identity: artifact.identity });
  const operationalState = artifact.mcp_operational_state ?? 'unknown';
  const hasStartupFailures = Number(artifact.mcp_startup_failure_count ?? 0) > 0;
  const hasRuntimeFaults = Number(artifact.mcp_runtime_fault_count ?? 0) > 0;
  const recommendedAction = hasRuntimeFaults
    ? 'review_runtime_diagnostics'
    : hasStartupFailures ? 'review_startup_diagnostics' : 'start_session';
  const recoveryKind = hasRuntimeFaults
    ? 'diagnostic_review'
    : hasStartupFailures ? 'startup_diagnostic_review' : 'no_recovery';
  return {
    artifact_path: artifactPath,
    generated_at: artifact.generated_at ?? null,
    mcp_operational_state: operationalState,
    mcp_startup_failure_summary: artifact.mcp_startup_failure_summary ?? '0',
    mcp_runtime_fault_summary: artifact.mcp_runtime_fault_summary ?? '0',
    recommended_action: artifact.recommended_action ?? recommendedAction,
    recommended_action_display: artifact.recommended_action_display ?? recommendedAction.replace(/_/g, ' '),
    recommended_command: artifact.recommended_command ?? (recommendedAction === 'start_session' ? null : handoffs.mcp_preflight_read),
    recovery_kind: artifact.recovery_kind ?? recoveryKind,
    recovery_kind_display: artifact.recovery_kind_display ?? recoveryKind.replace(/_/g, ' '),
    recovery_primary_command: artifact.recovery_primary_command ?? (recoveryKind === 'no_recovery' ? null : handoffs.mcp_preflight_read),
    recovery_followup_command: artifact.recovery_followup_command ?? (recoveryKind === 'no_recovery' ? null : handoffs.mcp_preflight_read_json),
    handoffs: artifact.handoffs ?? handoffs,
  };
}

function classifyPersistedSessionIssueOutcome(entry) {
  const issueCode = classifyPersistedSessionIssueCode(entry);
  if (!issueCode) return null;
  return classifySessionIssueOutcomeCode(issueCode);
}

function summarizeRequestPosture(requestOutcomeCounts = {}) {
  const counts = {
    invalid_control_traffic: Number(requestOutcomeCounts?.invalid_request ?? 0),
    closed_session_retries: Number(requestOutcomeCounts?.rejected_closed ?? 0),
    runtime_failures:
      Number(requestOutcomeCounts?.dispatch_failure ?? 0)
      + Number(requestOutcomeCounts?.request_runtime_failure ?? 0)
      + Number(requestOutcomeCounts?.interactive_runtime_failure ?? 0)
      + Number(requestOutcomeCounts?.request_error ?? 0),
  };
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return {
      request_outcome_total: 0,
      request_posture: 'clean',
      request_posture_display: 'clean',
    };
  }
  const postureOrder = ['runtime_failures', 'invalid_control_traffic', 'closed_session_retries'];
  const [requestPosture] = postureOrder
    .map((key) => [key, counts[key]])
    .sort((left, right) => right[1] - left[1] || postureOrder.indexOf(left[0]) - postureOrder.indexOf(right[0]))[0];
  return {
    request_outcome_total: total,
    request_posture: requestPosture,
    request_posture_display: `${requestPosture} (${total})`,
  };
}

function summarizeOperationalPosture({ mcpOperationalState = 'unknown', requestPosture = 'clean', lastLifecycleState = null } = {}) {
  let operationalPosture = 'healthy';
  if (mcpOperationalState === 'runtime_faulted') operationalPosture = 'mcp_runtime_faulted';
  else if (mcpOperationalState === 'startup_degraded') operationalPosture = 'mcp_startup_degraded';
  else if (requestPosture === 'runtime_failures') operationalPosture = 'request_runtime_failures';
  else if (requestPosture === 'invalid_control_traffic') operationalPosture = 'request_invalid_control_traffic';
  else if (requestPosture === 'closed_session_retries') operationalPosture = 'request_closed_session_retries';
  else if (lastLifecycleState === 'failed' || lastLifecycleState === 'interactive_loop_error') operationalPosture = 'lifecycle_failed';
  if (operationalPosture === 'healthy') {
    return {
      operational_posture: 'healthy',
      operational_posture_display: 'healthy',
    };
  }
  const lifecycleLabel = lastLifecycleState ?? 'none';
  return {
    operational_posture: operationalPosture,
    operational_posture_display: `${operationalPosture} [mcp=${mcpOperationalState}; request=${requestPosture}; lifecycle=${lifecycleLabel}]`,
  };
}

function summarizePersistedSession({ session, sessionDir, siteRoot = SITE_ROOT, naradaDir = NARADA_DIR } = {}) {
  const heartbeat = readJsonFile(join(sessionDir, 'heartbeat.json'));
  const entries = readJsonlFile(join(sessionDir, 'session.jsonl'));
  const parseErrors = entries.parse_errors ?? [];
  const startupFailures = [];
  const runtimeDiagnostics = [];
  let linkedPreflight = null;
  const lifecycleStateCounts = {};
  const requestOutcomeCounts = {};
  const requestIssueCounts = {};
  let lastEventKind = null;
  let lastEventAt = null;
  let lastTerminalState = null;
  let lastLifecycleEventKind = null;
  let lastLifecycleAt = null;
  let lastLifecycleState = null;
  for (const entry of entries) {
    if (entry?.event === 'mcp_preflight_artifact_linked') linkedPreflight = entry;
    lastEventKind = entry?.event_kind ?? entry?.event ?? lastEventKind;
    lastEventAt = entry?.timestamp ?? entry?.occurred_at ?? entry?.payload?.occurred_at ?? entry?.payload?.created_at ?? lastEventAt;
    const lifecycleEventKind = entry?.event ?? entry?.event_kind ?? null;
    const lifecycleOccurredAt = entry?.timestamp ?? entry?.occurred_at ?? entry?.payload?.occurred_at ?? entry?.payload?.created_at ?? null;
    const lifecycleState = classifyPersistedSessionLifecycleState(entry);
    if (lifecycleState) {
      incrementInventoryCounter(lifecycleStateCounts, lifecycleState);
      lastLifecycleEventKind = lifecycleEventKind ?? lastLifecycleEventKind;
      lastLifecycleAt = lifecycleOccurredAt ?? lastLifecycleAt;
      lastLifecycleState = lifecycleState;
    }
    const issueCode = classifyPersistedSessionIssueCode(entry);
    if (issueCode) incrementInventoryCounter(requestIssueCounts, issueCode);
    const issueOutcome = classifyPersistedSessionIssueOutcome(entry);
    if (issueOutcome) incrementInventoryCounter(requestOutcomeCounts, issueOutcome);
    if (entry?.event_kind === 'input_completed' || entry?.event === 'input_event_completed') {
      lastTerminalState = entry?.payload?.terminal_state ?? entry?.terminal_state ?? lastTerminalState;
    }
    if (entry?.event_kind !== 'carrier_diagnostic_recorded') continue;
    const payload = entry.payload ?? {};
    if (payload.diagnostic_code === 'mcp_runtime_fault') {
      runtimeDiagnostics.push(payload);
    } else {
      startupFailures.push({
        server_name: payload.server_name,
        code: payload.diagnostic_code ?? payload.code,
      });
    }
  }
  const preflightArtifact = readMcpPreflightArtifact({
    artifactDir: join(naradaDir, 'runtime', 'agent-cli', 'mcp-preflight'),
    session,
    identity: heartbeat?.agent_id ?? IDENTITY,
    siteRoot,
  });
  const operationLifecycle = summarizePersistedOperationLifecycle(entries);
  const hostCommandLifecycle = summarizePersistedHostCommandLifecycle(entries);
  const requestPosture = summarizeRequestPosture(requestOutcomeCounts);
  const handoffs = {
    ...buildPersistedSessionHandoffs({ session, identity: heartbeat?.agent_id ?? IDENTITY }),
    ...buildPersistedHostCommandOutputHandoffs({
      session,
      identity: heartbeat?.agent_id ?? IDENTITY,
      outputRef: hostCommandLifecycle.last_host_command_output_ref,
    }),
  };
  let mcpOperationalState = 'unknown';
  if (runtimeDiagnostics.length > 0) mcpOperationalState = 'runtime_faulted';
  else if (startupFailures.length > 0) mcpOperationalState = 'startup_degraded';
  else if (linkedPreflight?.mcp_operational_state) mcpOperationalState = linkedPreflight.mcp_operational_state;
  else if (preflightArtifact?.mcp_operational_state) mcpOperationalState = preflightArtifact.mcp_operational_state;
  const operationalPosture = summarizeOperationalPosture({
    mcpOperationalState,
    requestPosture: requestPosture.request_posture,
    lastLifecycleState,
  });
  const recommendedAction = summarizePersistedSessionRecommendedAction({
    operationalPosture: operationalPosture.operational_posture,
    mcpOperationalState,
    requestPosture: requestPosture.request_posture,
    handoffs,
  });
  const recoveryPlan = summarizePersistedSessionRecoveryPlan({
    operationalPosture: operationalPosture.operational_posture,
    mcpOperationalState,
    requestPosture: requestPosture.request_posture,
    handoffs,
  });
  return {
    session,
    session_path: join(sessionDir, 'session.jsonl'),
    agent_id: heartbeat?.agent_id ?? null,
    runtime: heartbeat?.runtime ?? null,
    mode: heartbeat?.mode ?? null,
    started_at: heartbeat?.started_at ?? null,
    heartbeat_at: heartbeat?.heartbeat_at ?? null,
    heartbeat_status: heartbeat?.status ?? 'missing',
    heartbeat_display: heartbeat?.heartbeat_at ? `${heartbeat.status ?? 'unknown'} @ ${heartbeat.heartbeat_at}` : (heartbeat?.status ?? 'missing'),
    session_event_count: entries.length,
    session_jsonl_parse_error_count: parseErrors.length,
    session_jsonl_parse_error_sample: parseErrors.slice(0, 3),
    last_event_kind: lastEventKind,
    last_event_at: lastEventAt,
    last_terminal_state: lastTerminalState,
    operational_posture: operationalPosture.operational_posture,
    operational_posture_display: operationalPosture.operational_posture_display,
    recommended_action: recommendedAction.recommended_action,
    recommended_action_display: recommendedAction.recommended_action_display,
    recommended_command: recommendedAction.recommended_command,
    recovery_kind: recoveryPlan.recovery_kind,
    recovery_kind_display: recoveryPlan.recovery_kind_display,
    recovery_primary_command: recoveryPlan.recovery_primary_command,
    recovery_followup_command: recoveryPlan.recovery_followup_command,
    last_lifecycle_event_kind: lastLifecycleEventKind,
    last_lifecycle_at: lastLifecycleAt,
    last_lifecycle_state: lastLifecycleState,
    lifecycle_state_counts: lifecycleStateCounts,
    lifecycle_state_summary: formatInventoryCounts(lifecycleStateCounts),
    request_outcome_total: requestPosture.request_outcome_total,
    request_posture: requestPosture.request_posture,
    request_posture_display: requestPosture.request_posture_display,
    request_outcome_counts: requestOutcomeCounts,
    request_outcome_summary: formatInventoryCounts(requestOutcomeCounts),
    request_issue_counts: requestIssueCounts,
    request_issue_summary: formatInventoryCounts(requestIssueCounts),
    operation_event_count: operationLifecycle.operation_event_count,
    operation_event_counts: operationLifecycle.operation_event_counts,
    operation_event_summary: operationLifecycle.operation_event_summary,
    directive_kind_counts: operationLifecycle.directive_kind_counts,
    directive_kind_summary: operationLifecycle.directive_kind_summary,
    directive_visibility_counts: operationLifecycle.directive_visibility_counts,
    directive_visibility_summary: operationLifecycle.directive_visibility_summary,
    operation_id_counts: operationLifecycle.operation_id_counts,
    operation_id_summary: operationLifecycle.operation_id_summary,
    last_operation_id: operationLifecycle.last_operation_id,
    last_directive_kind: operationLifecycle.last_directive_kind,
    last_directive_visibility: operationLifecycle.last_directive_visibility,
    last_operation_event_kind: operationLifecycle.last_operation_event_kind,
    last_operation_at: operationLifecycle.last_operation_at,
    host_command_event_count: hostCommandLifecycle.host_command_event_count,
    host_command_event_counts: hostCommandLifecycle.host_command_event_counts,
    host_command_event_summary: hostCommandLifecycle.host_command_event_summary,
    host_command_terminal_state_counts: hostCommandLifecycle.host_command_terminal_state_counts,
    host_command_terminal_state_summary: hostCommandLifecycle.host_command_terminal_state_summary,
    last_host_command_id: hostCommandLifecycle.last_host_command_id,
    last_host_command_summary: hostCommandLifecycle.last_host_command_summary,
    last_host_command_terminal_state: hostCommandLifecycle.last_host_command_terminal_state,
    last_host_command_output_ref: hostCommandLifecycle.last_host_command_output_ref,
    last_host_command_output_reader_tool: hostCommandLifecycle.last_host_command_output_reader_tool,
    last_host_command_event_kind: hostCommandLifecycle.last_host_command_event_kind,
    last_host_command_at: hostCommandLifecycle.last_host_command_at,
    mcp_operational_state: mcpOperationalState,
    mcp_startup_failure_summary: startupFailures.length > 0
      ? formatMcpStartupFailureSummary(startupFailures)
      : (linkedPreflight?.mcp_startup_failure_summary ?? preflightArtifact?.mcp_startup_failure_summary ?? '0'),
    mcp_runtime_fault_summary: runtimeDiagnostics.length > 0
      ? formatMcpRuntimeDiagnosticSummary(runtimeDiagnostics)
      : (linkedPreflight?.mcp_runtime_fault_summary ?? preflightArtifact?.mcp_runtime_fault_summary ?? '0'),
    mcp_preflight_artifact_path: linkedPreflight?.artifact_path ?? preflightArtifact?.artifact_path ?? null,
    mcp_preflight_operational_state: linkedPreflight?.mcp_operational_state ?? preflightArtifact?.mcp_operational_state ?? null,
    mcp_preflight_startup_failure_summary: linkedPreflight?.mcp_startup_failure_summary ?? preflightArtifact?.mcp_startup_failure_summary ?? null,
    mcp_preflight_runtime_fault_summary: linkedPreflight?.mcp_runtime_fault_summary ?? preflightArtifact?.mcp_runtime_fault_summary ?? null,
    mcp_preflight_recommended_action: linkedPreflight?.recommended_action ?? preflightArtifact?.recommended_action ?? null,
    mcp_preflight_recommended_action_display: linkedPreflight?.recommended_action_display ?? preflightArtifact?.recommended_action_display ?? null,
    mcp_preflight_recommended_command: linkedPreflight?.recommended_command ?? preflightArtifact?.recommended_command ?? null,
    mcp_preflight_recovery_kind: linkedPreflight?.recovery_kind ?? preflightArtifact?.recovery_kind ?? null,
    mcp_preflight_recovery_kind_display: linkedPreflight?.recovery_kind_display ?? preflightArtifact?.recovery_kind_display ?? null,
    mcp_preflight_recovery_primary_command: linkedPreflight?.recovery_primary_command ?? preflightArtifact?.recovery_primary_command ?? null,
    mcp_preflight_recovery_followup_command: linkedPreflight?.recovery_followup_command ?? preflightArtifact?.recovery_followup_command ?? null,
    mcp_preflight_handoffs: linkedPreflight?.handoffs ?? preflightArtifact?.handoffs ?? null,
    handoffs,
  };
}

function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonlFile(path) {
  if (!existsSync(path)) return [];
  try {
    const parseErrors = [];
    const entries = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          parseErrors.push({
            line,
            error: 'invalid_json',
          });
          return null;
        }
      })
      .filter(Boolean);
    if (parseErrors.length > 0) {
      Object.defineProperty(entries, 'parse_errors', {
        value: parseErrors,
        enumerable: false,
        writable: false,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

function appendJsonlRecord(path, payload) {
  const line = `${JSON.stringify(payload)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  let directoryFd = null;
  try {
    writeSync(fd, line, null, 'utf8');
    if (ENABLE_SESSION_FSYNC) {
      try {
        fsyncSync(fd);
      } catch {
        // best-effort durability
      }
      try {
        directoryFd = openSync(dirname(path), 'r');
        fsyncSync(directoryFd);
      } catch {
        // directory fsync is best-effort for cross-platform support.
      }
    }
  } finally {
    if (directoryFd !== null) {
      closeSync(directoryFd);
    }
    closeSync(fd);
  }
}

function appendSession(path, entry) {
  appendJsonlRecord(path, entry);
}

function sessionLogEntry({ role, content, source, authorityRef, toolCallId, eventId, transport, directiveId }) {
  const entry = { role, content, timestamp: new Date().toISOString() };
  if (toolCallId) entry.tool_call_id = toolCallId;
  if (source) entry.source = source;
  if (authorityRef) entry.authority_ref = authorityRef;
  if (eventId) entry.event_id = eventId;
  if (transport) entry.transport = transport;
  if (directiveId) entry.directive_id = directiveId;
  return entry;
}

function sessionEventEntry(event, payload = {}) {
  return { role: 'event', event, ...payload, timestamp: new Date().toISOString() };
}

function randomId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function readDirFiles(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export {
  appendSession,
  readJsonFile,
  readJsonlFile,
  runSessionEventsRead,
  runSessionOperationsRead,
  runSessionSync,
  runSessionRecovery,
  runSessionRead,
  runSessionInventory,
  runSessionInventoryActions,
  runSessionInventoryEvents,
  runSessionInventoryHostCommands,
  runSessionInventoryOperations,
  runSessionInventoryRecovery,
  readPersistedSessionEvents,
  filterPersistedSessionEvents,
  filterSessionInventory,
  summarizeSessionInventoryGroups,
  readPersistedSession,
  readSessionInventory,
  sessionEventEntry,
  sessionLogEntry,
};

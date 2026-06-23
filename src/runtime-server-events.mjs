function isSessionLifecycleEvent(event) {
  return event?.event === 'session_started' || event?.event === 'session_status' || event?.event === 'session_closed';
}

export function formatStartupMcpSummary(event) {
  if (!event || event.event !== 'session_started') return null;
  if (event.mcp_operational_state === 'healthy') return null;
  const parts = [`MCP state=${event.mcp_operational_state}`];
  if (event.mcp_startup_failure_count > 0 && event.mcp_startup_failure_summary) {
    parts.push(`startup=${event.mcp_startup_failure_summary}`);
  }
  if (event.mcp_runtime_fault_count > 0 && event.mcp_runtime_fault_summary) {
    parts.push(`runtime=${event.mcp_runtime_fault_summary}`);
  }
  return `[agent-runtime-server] ${parts.join(' | ')}`;
}

export function formatStartupMcpEvent(event) {
  if (!event || event.event !== 'session_started') return null;
  if (event.mcp_operational_state === 'healthy') return null;
  return {
    schema: 'narada.agent_runtime_server.wrapper_event.v1',
    event: 'mcp_startup_status',
    timestamp: event.timestamp ?? new Date().toISOString(),
    agent_id: event.agent_id ?? null,
    session_id: event.session_id ?? null,
    mcp_operational_state: event.mcp_operational_state ?? null,
    mcp_startup_failure_count: event.mcp_startup_failure_count ?? 0,
    mcp_startup_failure_summary: event.mcp_startup_failure_summary ?? '0',
    mcp_runtime_fault_count: event.mcp_runtime_fault_count ?? 0,
    mcp_runtime_fault_summary: event.mcp_runtime_fault_summary ?? '0',
  };
}

export function formatRuntimeMcpFaultSummary(event) {
  if (!event || event.event !== 'carrier_diagnostic_recorded') return null;
  if (event.diagnostic_code !== 'mcp_runtime_fault') return null;
  const serverName = event.server_name ?? 'unknown';
  const toolName = event.tool_name ?? '<missing>';
  const errorCode = event.error_code ? ` ${event.error_code}` : '';
  return `[agent-runtime-server] MCP runtime fault ${serverName}:${toolName}${errorCode}`;
}

export function formatRuntimeMcpFaultEvent(event) {
  if (!event || event.event !== 'carrier_diagnostic_recorded') return null;
  if (event.diagnostic_code !== 'mcp_runtime_fault') return null;
  return {
    schema: 'narada.agent_runtime_server.wrapper_event.v1',
    event: 'mcp_runtime_fault',
    timestamp: event.timestamp ?? new Date().toISOString(),
    agent_id: event.agent_id ?? null,
    session_id: event.session_id ?? null,
    diagnostic_code: event.diagnostic_code,
    server_name: event.server_name ?? 'unknown',
    tool_name: event.tool_name ?? '<missing>',
    error_code: event.error_code ?? null,
  };
}

export function formatSessionWorkflowSummary(event) {
  if (!event || !isSessionLifecycleEvent(event)) return null;
  if (!event.recommended_action || event.recommended_action === 'review_session_summary') return null;
  if (!event.recommended_command) return null;
  return `[agent-runtime-server] Session workflow ${event.recommended_action_display ?? event.recommended_action} | command=${event.recommended_command}`;
}

export function formatSessionOperationsSummary(event) {
  if (!event || event.event !== 'session_operations') return null;
  if (!event.operation?.operation_event_summary) return null;
  const command = event.handoffs?.session_operations ?? 'narada-agent-cli --session-operations';
  return `[agent-runtime-server] Session operations: ${event.operation.operation_event_summary} | command=${command}`;
}

export function formatSessionWorkflowEvent(event) {
  if (!event || !isSessionLifecycleEvent(event)) return null;
  if (!event.recommended_action || event.recommended_action === 'review_session_summary') return null;
  if (!event.recommended_command) return null;
  return {
    schema: 'narada.agent_runtime_server.wrapper_event.v1',
    event: 'session_workflow_recommendation',
    timestamp: event.timestamp ?? new Date().toISOString(),
    source_event: event.event,
    request_id: event.request_id ?? null,
    agent_id: event.agent_id ?? null,
    session_id: event.session_id ?? null,
    operational_posture: event.operational_posture ?? null,
    operational_posture_display: event.operational_posture_display ?? null,
    recommended_action: event.recommended_action ?? null,
    recommended_action_display: event.recommended_action_display ?? null,
    recommended_command: event.recommended_command ?? null,
    recovery_kind: event.recovery_kind ?? null,
    recovery_kind_display: event.recovery_kind_display ?? null,
    recovery_primary_command: event.recovery_primary_command ?? null,
    recovery_followup_command: event.recovery_followup_command ?? null,
    handoffs: event.handoffs ?? null,
  };
}

export function formatSessionOperationsEvent(event) {
  if (!event || event.event !== 'session_operations') return null;
  return {
    schema: 'narada.agent_runtime_server.wrapper_event.v1',
    event: 'session_operations_snapshot',
    timestamp: event.timestamp ?? new Date().toISOString(),
    source_event: event.event,
    request_id: event.request_id ?? null,
    agent_id: event.agent_id ?? null,
    session_id: event.session_id ?? null,
    terminal_state: event.terminal_state ?? null,
    active_turn_state: event.active_turn_state ?? null,
    active_turn_id: event.active_turn_id ?? null,
    mcp_operational_state: event.mcp_operational_state ?? null,
    mcp_preflight_operational_state: event.mcp_preflight_operational_state ?? null,
    request_posture: event.request_posture ?? null,
    request_posture_display: event.request_posture_display ?? null,
    operational_posture: event.operational_posture ?? null,
    operational_posture_display: event.operational_posture_display ?? null,
    recommended_action: event.recommended_action ?? null,
    recommended_action_display: event.recommended_action_display ?? null,
    recommended_command: event.recommended_command ?? null,
    recovery_kind: event.recovery_kind ?? null,
    recovery_kind_display: event.recovery_kind_display ?? null,
    recovery_primary_command: event.recovery_primary_command ?? null,
    recovery_followup_command: event.recovery_followup_command ?? null,
    handoffs: event.handoffs ?? null,
    operation: event.operation ?? null,
    event_summary: event.event_summary ?? null,
    session_path: event.session_path ?? null,
    events_path: event.events_path ?? null,
    session_event_count: event.session_event_count ?? null,
    last_event_kind: event.last_event_kind ?? null,
    last_event_at: event.last_event_at ?? null,
  };
}

export function formatPreflightWorkflowSummary(event) {
  if (!event || !isSessionLifecycleEvent(event)) return null;
  if (!event.mcp_preflight_recommended_action || event.mcp_preflight_recommended_action === 'start_session') return null;
  if (!event.mcp_preflight_recommended_command) return null;
  return `[agent-runtime-server] Preflight workflow ${event.mcp_preflight_recommended_action_display ?? event.mcp_preflight_recommended_action} | command=${event.mcp_preflight_recommended_command}`;
}

export function formatPreflightWorkflowEvent(event) {
  if (!event || !isSessionLifecycleEvent(event)) return null;
  if (!event.mcp_preflight_recommended_action || event.mcp_preflight_recommended_action === 'start_session') return null;
  if (!event.mcp_preflight_recommended_command) return null;
  return {
    schema: 'narada.agent_runtime_server.wrapper_event.v1',
    event: 'preflight_workflow_recommendation',
    timestamp: event.timestamp ?? new Date().toISOString(),
    source_event: event.event,
    request_id: event.request_id ?? null,
    agent_id: event.agent_id ?? null,
    session_id: event.session_id ?? null,
    mcp_preflight_operational_state: event.mcp_preflight_operational_state ?? null,
    mcp_preflight_recommended_action: event.mcp_preflight_recommended_action ?? null,
    mcp_preflight_recommended_action_display: event.mcp_preflight_recommended_action_display ?? null,
    mcp_preflight_recommended_command: event.mcp_preflight_recommended_command ?? null,
    mcp_preflight_recovery_kind: event.mcp_preflight_recovery_kind ?? null,
    mcp_preflight_recovery_kind_display: event.mcp_preflight_recovery_kind_display ?? null,
    mcp_preflight_recovery_primary_command: event.mcp_preflight_recovery_primary_command ?? null,
    mcp_preflight_recovery_followup_command: event.mcp_preflight_recovery_followup_command ?? null,
    mcp_preflight_handoffs: event.mcp_preflight_handoffs ?? null,
  };
}

export function formatWrapperStatusEvent(event) {
  if (!event || (!isSessionLifecycleEvent(event) && event.event !== 'session_operations')) return null;
  return {
    schema: 'narada.agent_runtime_server.wrapper_event.v1',
    event: 'session_status_snapshot',
    timestamp: event.timestamp ?? new Date().toISOString(),
    source_event: event.event,
    request_id: event.request_id ?? null,
    terminal_state: event.terminal_state ?? null,
    agent_id: event.agent_id ?? null,
    session_id: event.session_id ?? null,
    active_turn_state: event.active_turn_state ?? null,
    active_turn_id: event.active_turn_id ?? null,
    mcp_operational_state: event.mcp_operational_state ?? null,
    mcp_startup_failure_count: event.mcp_startup_failure_count ?? 0,
    mcp_startup_failure_summary: event.mcp_startup_failure_summary ?? '0',
    mcp_runtime_fault_count: event.mcp_runtime_fault_count ?? 0,
    mcp_runtime_fault_summary: event.mcp_runtime_fault_summary ?? '0',
    mcp_preflight_operational_state: event.mcp_preflight_operational_state ?? null,
    mcp_preflight_recommended_action: event.mcp_preflight_recommended_action ?? null,
    mcp_preflight_recommended_action_display: event.mcp_preflight_recommended_action_display ?? null,
    mcp_preflight_recommended_command: event.mcp_preflight_recommended_command ?? null,
    mcp_preflight_recovery_kind: event.mcp_preflight_recovery_kind ?? null,
    mcp_preflight_recovery_kind_display: event.mcp_preflight_recovery_kind_display ?? null,
    mcp_preflight_recovery_primary_command: event.mcp_preflight_recovery_primary_command ?? null,
    mcp_preflight_recovery_followup_command: event.mcp_preflight_recovery_followup_command ?? null,
    mcp_preflight_handoffs: event.mcp_preflight_handoffs ?? null,
    request_outcome_total: event.request_outcome_total ?? 0,
    request_posture: event.request_posture ?? 'clean',
    request_posture_display: event.request_posture_display ?? 'clean',
    operational_posture: event.operational_posture ?? null,
    operational_posture_display: event.operational_posture_display ?? null,
    recommended_action: event.recommended_action ?? null,
    recommended_action_display: event.recommended_action_display ?? null,
    recommended_command: event.recommended_command ?? null,
    recovery_kind: event.recovery_kind ?? null,
    recovery_kind_display: event.recovery_kind_display ?? null,
    recovery_primary_command: event.recovery_primary_command ?? null,
    recovery_followup_command: event.recovery_followup_command ?? null,
    handoffs: event.handoffs ?? null,
    session_event_count: event.session_event_count ?? 0,
    last_event_kind: event.last_event_kind ?? null,
    last_event_at: event.last_event_at ?? null,
    last_terminal_state: event.last_terminal_state ?? null,
  };
}

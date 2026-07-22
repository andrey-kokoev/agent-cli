function parseBooleanEnv(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseColorEnv(value, defaultValue) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return parseBooleanEnv(value, defaultValue);
}

function parseArgs(argv) {
  const opts = {};
  const markRemovedConversationArg = (flag) => {
    opts.removedConversationArgs = [...(opts.removedConversationArgs ?? []), flag];
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--identity' && i + 1 < argv.length) {
      opts.identity = argv[i + 1];
      i++;
    } else if (argv[i] === '--session' && i + 1 < argv.length) {
      opts.session = argv[i + 1];
      i++;
    } else if (argv[i] === '--message' && i + 1 < argv.length) {
      markRemovedConversationArg('--message');
      i++;
    } else if (argv[i] === '--message-file' && i + 1 < argv.length) {
      markRemovedConversationArg('--message-file');
      i++;
    } else if (argv[i] === '--authority-ref' && i + 1 < argv.length) {
      markRemovedConversationArg('--authority-ref');
      i++;
    } else if (argv[i] === '--operator-directive') {
      markRemovedConversationArg('--operator-directive');
    } else if (argv[i] === '--system-directive') {
      markRemovedConversationArg('--system-directive');
    } else if (argv[i] === '--enable-startup-system-directive') {
      markRemovedConversationArg('--enable-startup-system-directive');
    } else if (argv[i] === '--startup-system-directive' && i + 1 < argv.length) {
      markRemovedConversationArg('--startup-system-directive');
      i++;
    } else if (argv[i] === '--startup-system-directive-delay-ms' && i + 1 < argv.length) {
      markRemovedConversationArg('--startup-system-directive-delay-ms');
      i++;
    } else if (argv[i] === '--no-startup-system-directive') {
      markRemovedConversationArg('--no-startup-system-directive');
    } else if (argv[i] === '--interactive-after-message') {
      markRemovedConversationArg('--interactive-after-message');
    } else if (argv[i] === '--auto-approve') {
      markRemovedConversationArg('--auto-approve');
    } else if ((argv[i] === '--attach' || argv[i] === '--attach-endpoint') && i + 1 < argv.length) {
      opts.attach = true;
      opts.attachEndpoint = argv[i + 1];
      i++;
    } else if (argv[i] === '--attach') {
      opts.attach = true;
    } else if (argv[i] === '--launch-binding' && i + 1 < argv.length) {
      opts.launchBinding = argv[i + 1];
      i++;
    } else if (argv[i] === '--mcp-preflight') {
      opts.mcpPreflight = true;
    } else if (argv[i] === '--mcp-preflight-json') {
      opts.mcpPreflightJson = true;
    } else if (argv[i] === '--mcp-preflight-read') {
      opts.mcpPreflightRead = true;
    } else if (argv[i] === '--mcp-preflight-read-json') {
      opts.mcpPreflightReadJson = true;
    } else if (argv[i] === '--mcp-preflight-inventory') {
      opts.mcpPreflightInventory = true;
    } else if (argv[i] === '--mcp-preflight-inventory-json') {
      opts.mcpPreflightInventoryJson = true;
    } else if (argv[i] === '--mcp-preflight-actions') {
      opts.mcpPreflightActions = true;
    } else if (argv[i] === '--mcp-preflight-actions-json') {
      opts.mcpPreflightActionsJson = true;
    } else if (argv[i] === '--mcp-preflight-recovery') {
      opts.mcpPreflightRecovery = true;
    } else if (argv[i] === '--mcp-preflight-recovery-json') {
      opts.mcpPreflightRecoveryJson = true;
    } else if (argv[i] === '--mcp-preflight-diagnostics') {
      opts.mcpPreflightDiagnostics = true;
    } else if (argv[i] === '--mcp-preflight-diagnostics-json') {
      opts.mcpPreflightDiagnosticsJson = true;
    } else if (argv[i] === '--mcp-preflight-filter' && i + 1 < argv.length) {
      opts.mcpPreflightFilter = argv[i + 1];
      i++;
    } else if (argv[i] === '--mcp-preflight-match' && i + 1 < argv.length) {
      opts.mcpPreflightMatch = argv[i + 1];
      i++;
    } else if (argv[i] === '--mcp-preflight-diagnostics-filter' && i + 1 < argv.length) {
      opts.mcpPreflightDiagnosticsFilter = argv[i + 1];
      i++;
    } else if (argv[i] === '--session-inventory') {
      opts.sessionInventory = true;
    } else if (argv[i] === '--session-inventory-json') {
      opts.sessionInventoryJson = true;
    } else if (argv[i] === '--session-inventory-operations') {
      opts.sessionInventoryOperations = true;
    } else if (argv[i] === '--session-inventory-operations-json') {
      opts.sessionInventoryOperationsJson = true;
    } else if (argv[i] === '--session-inventory-host-commands') {
      opts.sessionInventoryHostCommands = true;
    } else if (argv[i] === '--session-inventory-host-commands-json') {
      opts.sessionInventoryHostCommandsJson = true;
    } else if (argv[i] === '--session-inventory-actions') {
      opts.sessionInventoryActions = true;
    } else if (argv[i] === '--session-inventory-actions-json') {
      opts.sessionInventoryActionsJson = true;
    } else if (argv[i] === '--session-inventory-recovery') {
      opts.sessionInventoryRecovery = true;
    } else if (argv[i] === '--session-inventory-recovery-json') {
      opts.sessionInventoryRecoveryJson = true;
    } else if (argv[i] === '--session-inventory-events') {
      opts.sessionInventoryEvents = true;
    } else if (argv[i] === '--session-inventory-events-json') {
      opts.sessionInventoryEventsJson = true;
    } else if (argv[i] === '--session-operations') {
      opts.sessionOperations = true;
    } else if (argv[i] === '--session-operations-json') {
      opts.sessionOperationsJson = true;
    } else if (argv[i] === '--session-inventory-filter' && i + 1 < argv.length) {
      opts.sessionInventoryFilter = argv[i + 1];
      i++;
    } else if (argv[i] === '--session-inventory-match' && i + 1 < argv.length) {
      opts.sessionInventoryMatch = argv[i + 1];
      i++;
    } else if (argv[i] === '--session-inventory-events-filter' && i + 1 < argv.length) {
      opts.sessionInventoryEventsFilter = argv[i + 1];
      i++;
    } else if (argv[i] === '--session-inventory-events-count' && i + 1 < argv.length) {
      opts.sessionInventoryEventsCount = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--session-recovery') {
      opts.sessionRecovery = true;
    } else if (argv[i] === '--session-recovery-json') {
      opts.sessionRecoveryJson = true;
    } else if (argv[i] === '--session-read') {
      opts.sessionRead = true;
    } else if (argv[i] === '--session-read-json') {
      opts.sessionReadJson = true;
    } else if (argv[i] === '--host-command-output-read') {
      opts.hostCommandOutputRead = true;
    } else if (argv[i] === '--host-command-output-read-json') {
      opts.hostCommandOutputReadJson = true;
    } else if (argv[i] === '--host-command-output-ref' && i + 1 < argv.length) {
      opts.hostCommandOutputRef = argv[i + 1];
      i++;
    } else if (argv[i] === '--session-events') {
      opts.sessionEvents = true;
    } else if (argv[i] === '--session-events-json') {
      opts.sessionEventsJson = true;
    } else if (argv[i] === '--session-events-filter' && i + 1 < argv.length) {
      opts.sessionEventsFilter = argv[i + 1];
      i++;
    } else if (argv[i] === '--session-events-count' && i + 1 < argv.length) {
      opts.sessionEventsCount = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--session-sync') {
      opts.sessionSync = true;
    } else if (argv[i] === '--session-sync-json') {
      opts.sessionSyncJson = true;
    } else if (argv[i] === '--session-sync-target' && i + 1 < argv.length) {
      opts.sessionSyncTarget = argv[i + 1];
      i++;
    } else if (argv[i] === '--session-sync-direction' && i + 1 < argv.length) {
      opts.sessionSyncDirection = argv[i + 1];
      i++;
    } else if (argv[i] === '--session-sync-dry-run') {
      opts.sessionSyncDryRun = true;
    } else if (argv[i] === '--session-sync-delete') {
      opts.sessionSyncDelete = true;
    } else if (argv[i] === '--stream') {
      opts.stream = true;
    } else if (argv[i] === '--no-stream') {
      opts.stream = false;
    } else if (argv[i] === '--color') {
      opts.color = true;
    } else if (argv[i] === '--no-color') {
      opts.color = false;
    } else if (argv[i] === '--control-jsonl' && i + 1 < argv.length) {
      markRemovedConversationArg('--control-jsonl');
      i++;
    } else if (argv[i] === '--model' && i + 1 < argv.length) {
      opts.model = argv[i + 1];
      i++;
    } else if (argv[i] === '--thinking' && i + 1 < argv.length) {
      opts.thinking = argv[i + 1];
      i++;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      opts.help = true;
    }
  }
  return opts;
}

function isAgentCliUtilityCommandMode(opts = {}) {
  return opts.help === true
    || opts.attach === true
    || typeof opts.launchBinding === 'string'
    || opts.mcpPreflight === true
    || opts.mcpPreflightJson === true
    || opts.mcpPreflightRead === true
    || opts.mcpPreflightReadJson === true
    || opts.mcpPreflightInventory === true
    || opts.mcpPreflightInventoryJson === true
    || opts.mcpPreflightActions === true
    || opts.mcpPreflightActionsJson === true
    || opts.mcpPreflightRecovery === true
    || opts.mcpPreflightRecoveryJson === true
    || opts.mcpPreflightDiagnostics === true
    || opts.mcpPreflightDiagnosticsJson === true
    || opts.sessionInventory === true
    || opts.sessionInventoryJson === true
    || opts.sessionInventoryOperations === true
    || opts.sessionInventoryOperationsJson === true
    || opts.sessionInventoryHostCommands === true
    || opts.sessionInventoryHostCommandsJson === true
    || opts.sessionInventoryActions === true
    || opts.sessionInventoryActionsJson === true
    || opts.sessionInventoryRecovery === true
    || opts.sessionInventoryRecoveryJson === true
    || opts.sessionInventoryEvents === true
    || opts.sessionInventoryEventsJson === true
    || opts.sessionOperations === true
    || opts.sessionOperationsJson === true
    || opts.sessionRecovery === true
    || opts.sessionRecoveryJson === true
    || opts.sessionRead === true
    || opts.sessionReadJson === true
    || opts.hostCommandOutputRead === true
    || opts.hostCommandOutputReadJson === true
    || opts.sessionEvents === true
    || opts.sessionEventsJson === true
    || opts.sessionSync === true
    || opts.sessionSyncJson === true;
}

export {
  isAgentCliUtilityCommandMode,
  parseArgs,
  parseBooleanEnv,
  parseColorEnv,
};

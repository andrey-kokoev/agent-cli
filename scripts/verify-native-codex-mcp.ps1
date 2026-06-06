param(
  [string]$Text = "proof-123"
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RunRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-cli-native-codex-mcp-" + [System.Guid]::NewGuid().ToString("N"))
$FixturePath = Join-Path $RunRoot "fixture-mcp-server.mjs"
New-Item -ItemType Directory -Path $RunRoot -Force | Out-Null

@'
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') {
    console.log(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-cli-native-fixture', version: '0.0.0' }
      }
    }));
    return;
  }
  if (request.method === 'tools/list') {
    console.log(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [{
          name: 'echo_text',
          description: 'Return exactly "native-ok:" followed by the provided text.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false
          }
        }]
      }
    }));
    return;
  }
  if (request.method === 'tools/call') {
    const text = request.params?.arguments?.text ?? '';
    console.log(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: { content: [{ type: 'text', text: 'native-ok:' + text }] }
    }));
  }
});
'@ | Set-Content -LiteralPath $FixturePath -Encoding UTF8

$FixtureArg = $FixturePath.Replace("\", "/")
$Prompt = "You have access to an MCP server named agent-cli-native-fixture. Use its echo_text tool with text `"$Text`". Do not answer from memory. After the tool call, answer with exactly the tool result text and nothing else."
$CodexArgs = @(
  "exec",
  "--json",
  "--dangerously-bypass-approvals-and-sandbox",
  "-C",
  $RepoRoot,
  "-c",
  "approval_policy=`"never`"",
  "-c",
  "model_reasoning_effort=`"low`"",
  "-c",
  "mcp_servers.`"agent-cli-native-fixture`".command=`"node`"",
  "-c",
  "mcp_servers.`"agent-cli-native-fixture`".args=['$FixtureArg']",
  "-c",
  "mcp_servers.`"agent-cli-native-fixture`".default_tools_approval_mode=`"approve`"",
  $Prompt
)

try {
  $PreviousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $Output = & codex @CodexArgs 2>&1
  $CodexExitCode = $LASTEXITCODE
  $ErrorActionPreference = $PreviousErrorActionPreference
  $Events = @()
  foreach ($Line in $Output) {
    $TextLine = [string]$Line
    if (-not $TextLine.TrimStart().StartsWith("{")) { continue }
    try {
      $Events += ($TextLine | ConvertFrom-Json)
    } catch {}
  }
  $NativeToolEvents = @($Events | Where-Object { $_.item.type -eq "mcp_tool_call" })
  $EchoCompleted = [bool](@($NativeToolEvents | Where-Object {
    $_.type -eq "item.completed" -and
    $_.item.server -eq "agent-cli-native-fixture" -and
    $_.item.tool -eq "echo_text" -and
    $_.item.status -eq "completed" -and
    -not $_.item.error
  }).Count)
  $FinalText = (($Events | Where-Object { $_.type -eq "item.completed" -and $_.item.type -eq "agent_message" } | ForEach-Object { $_.item.text }) -join "")
  $Report = [ordered]@{
    native_tool_event_count = $NativeToolEvents.Count
    echo_completed = $EchoCompleted
    final_text = $FinalText
    codex_exit_code = $CodexExitCode
    raw_output_line_count = @($Output).Count
  }
  $Report | ConvertTo-Json -Depth 8
  if ($CodexExitCode -ne 0 -or -not $EchoCompleted -or $FinalText.Trim() -ne "native-ok:$Text") {
    exit 1
  }
} finally {
  Remove-Item -LiteralPath $RunRoot -Recurse -Force -ErrorAction SilentlyContinue
}

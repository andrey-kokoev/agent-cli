# Start-AgentCliSession.ps1
# narada_template_id: narada.agent_cli.windows_wrapper
# narada_template_version: 2
# narada_template_source: @narada2/agent-cli ./windows-wrapper-template
# narada_template_hash: __NARADA_TEMPLATE_HASH__

param(
    [Parameter(Mandatory)]
    [string]$IdentityName,

    [Parameter(Mandatory)]
    [string]$WorkDir,

    [string]$SessionName = ($IdentityName -replace '\.', '-'),

    [ValidateSet('openai-api', 'kimi-api', 'kimi-code-api', 'anthropic-api', 'codex-subscription')]
    [string]$IntelligenceProvider = 'kimi-api',

    [switch]$SessionInventory,

    [switch]$SessionInventoryJson,

    [switch]$SessionInventoryOperations,

    [switch]$SessionInventoryOperationsJson,

    [switch]$SessionInventoryHostCommands,

    [switch]$SessionInventoryHostCommandsJson,

    [switch]$SessionInventoryActions,

    [switch]$SessionInventoryActionsJson,

    [switch]$SessionInventoryRecovery,

    [switch]$SessionInventoryRecoveryJson,

    [switch]$SessionInventoryEvents,
    [switch]$SessionInventoryEventsJson,

    [ValidateSet('mcp_state', 'recommended_action', 'recovery_kind')]
    [string]$McpPreflightFilter,

    [string]$McpPreflightMatch,

    [ValidateSet('all', 'startup', 'runtime')]
    [string]$McpPreflightDiagnosticsFilter = 'all',

    [ValidateSet('operational_posture', 'request_posture', 'mcp_state', 'heartbeat_status', 'recommended_action', 'recovery_kind')]
    [string]$SessionInventoryFilter,

    [string]$SessionInventoryMatch,

    [ValidateSet('all', 'lifecycle', 'issues', 'diagnostics')]
    [string]$SessionInventoryEventsFilter = 'all',

    [int]$SessionInventoryEventsCount = 20,

    [switch]$SessionRead,

    [switch]$SessionRecovery,

    [switch]$SessionRecoveryJson,

    [switch]$SessionReadJson,

    [switch]$HostCommandOutputRead,

    [switch]$HostCommandOutputReadJson,

    [string]$HostCommandOutputRef,

    [switch]$SessionEvents,

    [switch]$SessionEventsJson,

    [ValidateSet('all', 'lifecycle', 'issues', 'diagnostics')]
    [string]$SessionEventsFilter = 'all',

    [int]$SessionEventsCount = 20,

    [switch]$McpPreflightJson,

    [switch]$McpPreflightRead,

    [switch]$McpPreflightReadJson,

    [switch]$McpPreflightInventory,

    [switch]$McpPreflightInventoryJson,

    [switch]$McpPreflightActions,

    [switch]$McpPreflightActionsJson,

    [switch]$McpPreflightRecovery,

    [switch]$McpPreflightRecoveryJson,

    [switch]$McpPreflightDiagnostics,

    [switch]$McpPreflightDiagnosticsJson,

    [switch]$AutoApprove
)
$ErrorActionPreference = 'Stop'

$SiteRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$NaradaProperRoot = if ($env:NARADA_PROPER_ROOT) { $env:NARADA_PROPER_ROOT } else { $null }

if (-not ([string]$env:NODE_OPTIONS -match '(^|\s)--no-warnings(=|\s|$)')) {
    $env:NODE_OPTIONS = (($env:NODE_OPTIONS, '--no-warnings=ExperimentalWarning') | Where-Object { $_ }) -join ' '
}

function Resolve-NaradaPackageRoot {
    param([Parameter(Mandatory)][string]$PackageName)

    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $escaped = $PackageName.Replace('\', '\\').Replace("'", "\'")
        $script = "const { dirname } = require('node:path'); try { console.log(dirname(require.resolve('$escaped/package.json'))); } catch {}"
        $resolved = & $node.Source -e $script 2>$null
        if ($LASTEXITCODE -eq 0 -and $resolved) {
            return [string]$resolved
        }
    }

    if (-not $NaradaProperRoot) {
        throw "narada_package_not_resolvable: $PackageName; set NARADA_PROPER_ROOT or install the package where Node can resolve it"
    }

    if ($PackageName -eq '@narada2/agent-cli') {
        $agentCliRoot = if ($env:NARADA_AGENT_CLI_ROOT) { $env:NARADA_AGENT_CLI_ROOT } else { 'D:\code\agent-cli' }
        $agentCliPackageJson = Join-Path $agentCliRoot 'package.json'
        if (Test-Path -LiteralPath $agentCliPackageJson -PathType Leaf) {
            return $agentCliRoot
        }
    }

    $parts = $PackageName -split '/'
    return (Join-Path (Join-Path $NaradaProperRoot 'packages') $parts[$parts.Count - 1])
}

function Get-NaradaPackageJson {
    param([Parameter(Mandatory)][string]$PackageName)

    $packageRoot = Resolve-NaradaPackageRoot -PackageName $PackageName
    $packageJsonPath = Join-Path $packageRoot 'package.json'
    if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) {
        throw "narada_package_json_missing: $PackageName at $packageJsonPath"
    }
    return [pscustomobject]@{
        Root = $packageRoot
        Json = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
    }
}

function Resolve-NaradaPackageBin {
    param(
        [Parameter(Mandatory)][string]$PackageName,
        [Parameter(Mandatory)][string]$BinName
    )

    $package = Get-NaradaPackageJson -PackageName $PackageName
    $bin = $package.Json.bin
    $target = if ($bin -is [string]) { $bin } else { $bin.PSObject.Properties[$BinName].Value }
    if (-not $target) {
        throw "narada_package_bin_missing: $PackageName $BinName"
    }
    return Join-Path $package.Root $target
}

function Resolve-NaradaPackageExport {
    param(
        [Parameter(Mandatory)][string]$PackageName,
        [string]$ExportName = '.'
    )

    $package = Get-NaradaPackageJson -PackageName $PackageName
    $exports = $package.Json.exports
    $target = if ($exports -is [string] -and $ExportName -eq '.') {
        $exports
    } else {
        $exports.PSObject.Properties[$ExportName].Value
    }
    if (-not $target) {
        throw "narada_package_export_missing: $PackageName $ExportName"
    }
    return Join-Path $package.Root $target
}

$AgentCliPath = Resolve-NaradaPackageBin -PackageName '@narada2/agent-cli' -BinName 'narada-agent-cli'
$ProviderMetadataPath = Resolve-NaradaPackageExport -PackageName '@narada2/agent-cli' -ExportName './intelligence-providers'
$ProviderMetadata = (Get-Content $ProviderMetadataPath -Raw | ConvertFrom-Json).providers
$providerDefault = $ProviderMetadata.PSObject.Properties[$IntelligenceProvider].Value
if (-not $providerDefault) {
    Write-Error "No provider metadata found for $IntelligenceProvider in $ProviderMetadataPath"
    exit 1
}
$env:NARADA_INTELLIGENCE_PROVIDER = $IntelligenceProvider

function Import-DotEnvFile {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }

    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $parts = $trimmed -split '=', 2
        if ($parts.Count -ne 2) { continue }
        $name = $parts[0].Trim()
        if (-not $name) { continue }
        if ([Environment]::GetEnvironmentVariable($name, 'Process')) { continue }
        $value = $parts[1].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

Import-DotEnvFile -Path (Join-Path $SiteRoot '.env')

# Load API provider config if present
$ConfigPath = Join-Path (Resolve-NaradaPackageRoot -PackageName '@narada2/agent-cli') 'agent-cli-config.json'
$EffectiveConfigPath = if (Test-Path $ConfigPath) { $ConfigPath } else { $null }
if ($EffectiveConfigPath) {
    $config = Get-Content $EffectiveConfigPath -Raw | ConvertFrom-Json
    $configProvider = if ($config.provider) { [string]$config.provider } else { 'openai-api' }
    if ($configProvider -eq $IntelligenceProvider) {
        if ($config.api_key -and -not $env:NARADA_AI_API_KEY) {
            $env:NARADA_AI_API_KEY = $config.api_key
        }
        if ($config.base_url -and -not $env:NARADA_AI_BASE_URL) {
            $env:NARADA_AI_BASE_URL = $config.base_url
        }
        if ($config.model -and -not $env:NARADA_AI_MODEL) {
            $env:NARADA_AI_MODEL = $config.model
        }
    }
}

# Set window title for OSL binding and general identification
$Host.UI.RawUI.WindowTitle = $IdentityName

if (-not $env:NARADA_AI_BASE_URL) {
    if ($IntelligenceProvider -eq 'kimi-code-api' -and $env:NARADA_KIMI_CODE_API_BASE_URL) {
        $env:NARADA_AI_BASE_URL = $env:NARADA_KIMI_CODE_API_BASE_URL
    } else {
        $env:NARADA_AI_BASE_URL = $providerDefault.base_url
    }
}
if (-not $env:NARADA_AI_MODEL) {
    if ($IntelligenceProvider -eq 'kimi-api' -and $env:NARADA_KIMI_MODEL) {
        $env:NARADA_AI_MODEL = $env:NARADA_KIMI_MODEL
    } elseif ($IntelligenceProvider -eq 'kimi-code-api' -and $env:NARADA_KIMI_CODE_MODEL) {
        $env:NARADA_AI_MODEL = $env:NARADA_KIMI_CODE_MODEL
    } else {
        $env:NARADA_AI_MODEL = $providerDefault.default_model
    }
}
if ($IntelligenceProvider -eq 'kimi-api' -and -not $env:NARADA_AI_API_KEY -and $env:NARADA_KIMI_API_KEY) {
    $env:NARADA_AI_API_KEY = $env:NARADA_KIMI_API_KEY
}
if ($IntelligenceProvider -eq 'kimi-code-api' -and -not $env:NARADA_AI_API_KEY -and $env:KIMI_CODE_API_KEY) {
    $env:NARADA_AI_API_KEY = $env:KIMI_CODE_API_KEY
}
if ($IntelligenceProvider -eq 'anthropic-api' -and -not $env:NARADA_AI_API_KEY -and $env:ANTHROPIC_API_KEY) {
    $env:NARADA_AI_API_KEY = $env:ANTHROPIC_API_KEY
}

# Validate node is available
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "node.exe is required but not found on PATH."
    exit 1
}

# Validate agent-cli exists
if (-not (Test-Path $AgentCliPath)) {
    Write-Error "Agent CLI not found at $AgentCliPath"
    exit 1
}

# Validate API key is configured
if ($IntelligenceProvider -ne 'codex-subscription' -and -not $env:NARADA_AI_API_KEY) {
    Write-Error @"
No AI API key configured for provider '$IntelligenceProvider'. Set one of:
  - Environment variable: `$env:NARADA_AI_API_KEY = 'sk-...'
  - For kimi-api: `$env:NARADA_KIMI_API_KEY = '...'
  - For anthropic-api: `$env:ANTHROPIC_API_KEY = 'sk-ant-...'
  - Config file: $ConfigPath  (add `"api_key`": `"sk-...`" )
"@
    exit 1
}

if ($SessionInventory) {
    Write-Host "Session inventory..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $inventoryArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryJson) {
    Set-Location $WorkDir
    $inventoryJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-json')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryJsonArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryJsonArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryOperations) {
    Write-Host "Session operations..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $inventoryOperationArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-operations')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryOperationArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryOperationArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryOperationsJson) {
    Set-Location $WorkDir
    $inventoryOperationJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-operations-json')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryOperationJsonArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryOperationJsonArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryHostCommands) {
    Write-Host "Session host commands..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $inventoryHostCommandArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-host-commands')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryHostCommandArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryHostCommandArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryHostCommandsJson) {
    Set-Location $WorkDir
    $inventoryHostCommandJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-host-commands-json')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryHostCommandJsonArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryHostCommandJsonArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryActions) {
    Write-Host "Session inventory actions..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $inventoryActionArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-actions')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryActionArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryActionArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryActionsJson) {
    Set-Location $WorkDir
    $inventoryActionsJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-actions-json')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryActionsJsonArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryActionsJsonArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryRecovery) {
    Write-Host "Session inventory recovery..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $inventoryRecoveryArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-recovery')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryRecoveryArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryRecoveryArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryRecoveryJson) {
    Set-Location $WorkDir
    $inventoryRecoveryJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-recovery-json')
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryRecoveryJsonArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryRecoveryJsonArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryEvents) {
    Write-Host "Session inventory events..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $inventoryEventArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-events', '--session-inventory-events-filter', $SessionInventoryEventsFilter, '--session-inventory-events-count', $SessionInventoryEventsCount)
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryEventArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryEventArgs
    exit $LASTEXITCODE
}

if ($SessionInventoryEventsJson) {
    Set-Location $WorkDir
    $inventoryEventsJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--session-inventory-events-json', '--session-inventory-events-filter', $SessionInventoryEventsFilter, '--session-inventory-events-count', $SessionInventoryEventsCount)
    if ($SessionInventoryFilter -and $SessionInventoryMatch) {
        $inventoryEventsJsonArgs += @('--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch)
    }
    & node $AgentCliPath @inventoryEventsJsonArgs
    exit $LASTEXITCODE
}

if ($SessionRead) {
    Write-Host "Session read..." -ForegroundColor Cyan
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-read'
    exit $LASTEXITCODE
}

if ($SessionRecovery) {
    Write-Host "Session recovery..." -ForegroundColor Cyan
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-recovery'
    exit $LASTEXITCODE
}

if ($SessionRecoveryJson) {
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-recovery-json'
    exit $LASTEXITCODE
}

if ($SessionReadJson) {
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-read-json'
    exit $LASTEXITCODE
}

if ($HostCommandOutputRead) {
    Write-Host "Host command output..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $hostCommandOutputArgs = @('--identity', $IdentityName, '--session', $SessionName, '--host-command-output-read')
    if ($HostCommandOutputRef) {
        $hostCommandOutputArgs += @('--host-command-output-ref', $HostCommandOutputRef)
    }
    & node $AgentCliPath @hostCommandOutputArgs
    exit $LASTEXITCODE
}

if ($HostCommandOutputReadJson) {
    Set-Location $WorkDir
    $hostCommandOutputJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--host-command-output-read-json')
    if ($HostCommandOutputRef) {
        $hostCommandOutputJsonArgs += @('--host-command-output-ref', $HostCommandOutputRef)
    }
    & node $AgentCliPath @hostCommandOutputJsonArgs
    exit $LASTEXITCODE
}

if ($SessionEvents) {
    Write-Host "Session events..." -ForegroundColor Cyan
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-events' '--session-events-filter' $SessionEventsFilter '--session-events-count' $SessionEventsCount
    exit $LASTEXITCODE
}

if ($SessionEventsJson) {
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-events-json' '--session-events-filter' $SessionEventsFilter '--session-events-count' $SessionEventsCount
    exit $LASTEXITCODE
}

if ($McpPreflightJson) {
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--mcp-preflight-json'
    exit $LASTEXITCODE
}

if ($McpPreflightRead) {
    Write-Host "MCP preflight review..." -ForegroundColor Cyan
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--mcp-preflight-read'
    exit $LASTEXITCODE
}

if ($McpPreflightReadJson) {
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--mcp-preflight-read-json'
    exit $LASTEXITCODE
}

if ($McpPreflightInventory) {
    Write-Host "MCP preflight inventory..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $preflightInventoryArgs = @('--identity', $IdentityName, '--session', $SessionName, '--mcp-preflight-inventory')
    if ($McpPreflightFilter -and $McpPreflightMatch) {
        $preflightInventoryArgs += @('--mcp-preflight-filter', $McpPreflightFilter, '--mcp-preflight-match', $McpPreflightMatch)
    }
    & node $AgentCliPath @preflightInventoryArgs
    exit $LASTEXITCODE
}

if ($McpPreflightInventoryJson) {
    Set-Location $WorkDir
    $preflightInventoryJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--mcp-preflight-inventory-json')
    if ($McpPreflightFilter -and $McpPreflightMatch) {
        $preflightInventoryJsonArgs += @('--mcp-preflight-filter', $McpPreflightFilter, '--mcp-preflight-match', $McpPreflightMatch)
    }
    & node $AgentCliPath @preflightInventoryJsonArgs
    exit $LASTEXITCODE
}

if ($McpPreflightActions) {
    Write-Host "MCP preflight actions..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $preflightActionArgs = @('--identity', $IdentityName, '--session', $SessionName, '--mcp-preflight-actions')
    if ($McpPreflightFilter -and $McpPreflightMatch) {
        $preflightActionArgs += @('--mcp-preflight-filter', $McpPreflightFilter, '--mcp-preflight-match', $McpPreflightMatch)
    }
    & node $AgentCliPath @preflightActionArgs
    exit $LASTEXITCODE
}

if ($McpPreflightActionsJson) {
    Set-Location $WorkDir
    $preflightActionsJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--mcp-preflight-actions-json')
    if ($McpPreflightFilter -and $McpPreflightMatch) {
        $preflightActionsJsonArgs += @('--mcp-preflight-filter', $McpPreflightFilter, '--mcp-preflight-match', $McpPreflightMatch)
    }
    & node $AgentCliPath @preflightActionsJsonArgs
    exit $LASTEXITCODE
}

if ($McpPreflightRecovery) {
    Write-Host "MCP preflight recovery..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $preflightRecoveryArgs = @('--identity', $IdentityName, '--session', $SessionName, '--mcp-preflight-recovery')
    if ($McpPreflightFilter -and $McpPreflightMatch) {
        $preflightRecoveryArgs += @('--mcp-preflight-filter', $McpPreflightFilter, '--mcp-preflight-match', $McpPreflightMatch)
    }
    & node $AgentCliPath @preflightRecoveryArgs
    exit $LASTEXITCODE
}

if ($McpPreflightRecoveryJson) {
    Set-Location $WorkDir
    $preflightRecoveryJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--mcp-preflight-recovery-json')
    if ($McpPreflightFilter -and $McpPreflightMatch) {
        $preflightRecoveryJsonArgs += @('--mcp-preflight-filter', $McpPreflightFilter, '--mcp-preflight-match', $McpPreflightMatch)
    }
    & node $AgentCliPath @preflightRecoveryJsonArgs
    exit $LASTEXITCODE
}

if ($McpPreflightDiagnostics) {
    Write-Host "MCP preflight diagnostics..." -ForegroundColor Cyan
    Set-Location $WorkDir
    $preflightDiagnosticsArgs = @('--identity', $IdentityName, '--session', $SessionName, '--mcp-preflight-diagnostics', '--mcp-preflight-diagnostics-filter', $McpPreflightDiagnosticsFilter)
    if ($McpPreflightFilter -and $McpPreflightMatch) {
        $preflightDiagnosticsArgs += @('--mcp-preflight-filter', $McpPreflightFilter, '--mcp-preflight-match', $McpPreflightMatch)
    }
    & node $AgentCliPath @preflightDiagnosticsArgs
    exit $LASTEXITCODE
}

if ($McpPreflightDiagnosticsJson) {
    Set-Location $WorkDir
    $preflightDiagnosticsJsonArgs = @('--identity', $IdentityName, '--session', $SessionName, '--mcp-preflight-diagnostics-json', '--mcp-preflight-diagnostics-filter', $McpPreflightDiagnosticsFilter)
    if ($McpPreflightFilter -and $McpPreflightMatch) {
        $preflightDiagnosticsJsonArgs += @('--mcp-preflight-filter', $McpPreflightFilter, '--mcp-preflight-match', $McpPreflightMatch)
    }
    & node $AgentCliPath @preflightDiagnosticsJsonArgs
    exit $LASTEXITCODE
}

    & node $AgentCliPath @preflightRecoveryJsonArgs
    exit $LASTEXITCODE
}

$argList = @($AgentCliPath, '--identity', $IdentityName, '--session', $SessionName)
if ($AutoApprove) {
    $argList += '--auto-approve'
}

Write-Host "Starting agent-cli for $IdentityName..." -ForegroundColor Cyan
Write-Host "  Session: $SessionName" -ForegroundColor DarkGray
Write-Host "  WorkDir: $WorkDir" -ForegroundColor DarkGray
$displayModel = if ($env:NARADA_AI_MODEL) { $env:NARADA_AI_MODEL } else { 'gpt-4o' }
Write-Host "  Provider: $IntelligenceProvider" -ForegroundColor DarkGray
Write-Host "  Model:   $displayModel" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Preflight MCP fabric..." -ForegroundColor Cyan
$preflightArgs = @($AgentCliPath, '--identity', $IdentityName, '--session', $SessionName, '--mcp-preflight-json')
Set-Location $WorkDir
$preflightRaw = & node @preflightArgs
$preflightExitCode = $LASTEXITCODE
$preflight = $null
if ($preflightRaw) {
    try {
        $preflight = $preflightRaw | ConvertFrom-Json
    } catch {
        Write-Warning "MCP preflight returned non-JSON output; continuing with exit-code-only handling."
    }
}
if ($preflight) {
    Write-Host ("  MCP state: {0}" -f $preflight.mcp_operational_state) -ForegroundColor DarkGray
    if ($preflight.mcp_startup_failure_count -gt 0 -and $preflight.mcp_startup_failure_summary) {
        Write-Host ("  MCP startup failures: {0}" -f $preflight.mcp_startup_failure_summary) -ForegroundColor DarkYellow
    }
    if ($preflight.mcp_runtime_fault_count -gt 0 -and $preflight.mcp_runtime_fault_summary) {
        Write-Host ("  MCP runtime faults:   {0}" -f $preflight.mcp_runtime_fault_summary) -ForegroundColor DarkYellow
    }
    Write-Host ("  Recommended action:  {0}" -f $preflight.recommended_action_display) -ForegroundColor DarkGray
    if ($preflight.recommended_command) {
        Write-Host ("  Recommended command: {0}" -f $preflight.recommended_command) -ForegroundColor DarkYellow
    }
    if ($preflight.handoffs -and $preflight.handoffs.mcp_preflight_read) {
        Write-Host ("  Preflight review:    {0}" -f $preflight.handoffs.mcp_preflight_read) -ForegroundColor DarkGray
    }
    if ($preflight.artifact_path) {
        Write-Host ("  Preflight artifact:  {0}" -f $preflight.artifact_path) -ForegroundColor DarkGray
    }
}
}
if ($preflightExitCode -eq 1) {
    Write-Error "MCP preflight failed."
    exit 1
}
if ($preflightExitCode -eq 2) {
    Write-Warning "MCP preflight reported degraded startup posture; continuing interactive attach."
}
Write-Host ""
Set-Location $WorkDir
& node @argList

$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Warning "agent-cli exited with code $exitCode"

    $sessionRecoveryArgs = @($AgentCliPath, '--identity', $IdentityName, '--session', $SessionName, '--session-recovery-json')
    $sessionRecoveryRaw = & node @sessionRecoveryArgs
    $sessionRecoveryExitCode = $LASTEXITCODE
    $sessionRecovery = $null
    if ($sessionRecoveryExitCode -eq 0 -and $sessionRecoveryRaw) {
        try {
            $sessionRecovery = $sessionRecoveryRaw | ConvertFrom-Json
        } catch {
            Write-Warning "Session recovery returned non-JSON output; skipping post-session recovery guidance."
        }
    }

    if ($sessionRecovery -and $sessionRecovery.found -and $sessionRecovery.recovery) {
        $recommendedAction = [string]$sessionRecovery.recovery.recommended_action
        if ($recommendedAction -and $recommendedAction -ne 'review_session_summary') {
            Write-Host ""
            Write-Host "Post-session recovery..." -ForegroundColor Cyan
            if ($sessionRecovery.recovery.recovery_kind_display) {
                Write-Host ("  Recovery kind:      {0}" -f $sessionRecovery.recovery.recovery_kind_display) -ForegroundColor DarkGray
            }
            if ($sessionRecovery.recovery.recommended_action_display) {
                Write-Host ("  Recommended action: {0}" -f $sessionRecovery.recovery.recommended_action_display) -ForegroundColor DarkGray
            }
            if ($sessionRecovery.recovery.recommended_command) {
                Write-Host ("  Recommended command: {0}" -f $sessionRecovery.recovery.recommended_command) -ForegroundColor DarkYellow
            }
            if ($sessionRecovery.recovery.recovery_primary_command) {
                Write-Host ("  Recovery primary:   {0}" -f $sessionRecovery.recovery.recovery_primary_command) -ForegroundColor DarkYellow
            }
            if ($sessionRecovery.recovery.recovery_followup_command) {
                Write-Host ("  Recovery followup:  {0}" -f $sessionRecovery.recovery.recovery_followup_command) -ForegroundColor DarkGray
            }
            if ($sessionRecovery.record -and $sessionRecovery.record.handoffs -and $sessionRecovery.record.handoffs.session_recovery) {
                Write-Host ("  Session recovery:   {0}" -f $sessionRecovery.record.handoffs.session_recovery) -ForegroundColor DarkGray
            }
        }
    }
}

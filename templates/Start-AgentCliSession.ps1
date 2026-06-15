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

    [switch]$McpPreflightJson,

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
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-inventory'
    exit $LASTEXITCODE
}

if ($SessionInventoryJson) {
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-inventory-json'
    exit $LASTEXITCODE
}

if ($McpPreflightJson) {
    Set-Location $WorkDir
    & node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--mcp-preflight-json'
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
$preflightArgs = @($AgentCliPath, '--identity', $IdentityName, '--session', $SessionName, '--mcp-preflight')
Set-Location $WorkDir
& node @preflightArgs
$preflightExitCode = $LASTEXITCODE
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
}

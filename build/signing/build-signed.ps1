[CmdletBinding()]
param(
    [ValidateSet('nsis', 'dir')]
    [string]$Target = 'nsis',
    [switch]$SkipVerification
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'The Mineradio Windows signing build must run on Windows.'
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$builderPath = Join-Path $projectRoot 'node_modules\.bin\electron-builder.cmd'
$secretDir = Join-Path $projectRoot '.cert'
$localPfxPath = Join-Path $secretDir 'mineradio-self-signed.pfx'
$localCredentialPath = Join-Path $secretDir 'mineradio-signing-credential.xml'
$generatorPath = Join-Path $PSScriptRoot 'generate-self-signed-cert.ps1'
$verificationPath = Join-Path $PSScriptRoot 'verify-signatures.ps1'

if (-not (Test-Path -LiteralPath $builderPath)) {
    throw 'electron-builder is not installed. Run npm install before building.'
}

$previousEnvironment = @{}
foreach ($name in @('WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'SIGNTOOL_PATH')) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$certificateLink = [Environment]::GetEnvironmentVariable('WIN_CSC_LINK', 'Process')
if ([string]::IsNullOrWhiteSpace($certificateLink)) {
    $certificateLink = [Environment]::GetEnvironmentVariable('CSC_LINK', 'Process')
}

$certificatePassword = [Environment]::GetEnvironmentVariable('WIN_CSC_KEY_PASSWORD', 'Process')
if ($null -eq $certificatePassword) {
    $certificatePassword = [Environment]::GetEnvironmentVariable('CSC_KEY_PASSWORD', 'Process')
}

try {
    if ([string]::IsNullOrWhiteSpace($certificateLink)) {
        $localPfxExists = Test-Path -LiteralPath $localPfxPath -PathType Leaf
        $localCredentialExists = Test-Path -LiteralPath $localCredentialPath -PathType Leaf
        if (-not $localPfxExists -and -not $localCredentialExists) {
            Write-Host 'No signing certificate was configured. Generating a local self-signed certificate...'
            & $generatorPath
        } elseif (-not $localPfxExists -or -not $localCredentialExists) {
            throw "Local signing material is incomplete. Restore both $localPfxPath and $localCredentialPath from backup instead of generating a new certificate, or remove the remaining file intentionally before starting a new signing identity."
        }

        $credential = Import-Clixml -LiteralPath $localCredentialPath
        if ($credential -isnot [System.Management.Automation.PSCredential]) {
            throw "Invalid local signing credential: $localCredentialPath"
        }

        $certificateLink = $localPfxPath
        $certificatePassword = $credential.GetNetworkCredential().Password
        Write-Host "Using local self-signed certificate: $localPfxPath"
    } else {
        Write-Host 'Using the code-signing certificate supplied through the environment.'
    }

    [Environment]::SetEnvironmentVariable('WIN_CSC_LINK', $certificateLink, 'Process')
    [Environment]::SetEnvironmentVariable('WIN_CSC_KEY_PASSWORD', $certificatePassword, 'Process')

    $signToolPath = [Environment]::GetEnvironmentVariable('SIGNTOOL_PATH', 'Process')
    if ([string]::IsNullOrWhiteSpace($signToolPath)) {
        $windowsKitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
        if (Test-Path -LiteralPath $windowsKitsRoot) {
            $signTool = Get-ChildItem -Path $windowsKitsRoot -Recurse -Filter 'signtool.exe' -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Directory.Name -eq 'x64' } |
                Sort-Object -Property @{ Expression = {
                    try { [Version]$_.Directory.Parent.Name } catch { [Version]'0.0' }
                }; Descending = $true } |
                Select-Object -First 1
            if ($null -ne $signTool) {
                [Environment]::SetEnvironmentVariable('SIGNTOOL_PATH', $signTool.FullName, 'Process')
                Write-Host "Using Windows SDK signtool: $($signTool.FullName)"
            }
        }
    }

    $builderArguments = @('--win', $Target, '--config.forceCodeSigning=true')
    $installedElectron = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
    if (Test-Path -LiteralPath $installedElectron -PathType Leaf) {
        $builderArguments += '--config.electronDist=node_modules/electron/dist'
        Write-Host 'Using the Electron distribution installed in node_modules.'
    }

    Push-Location $projectRoot
    try {
        & $builderPath @builderArguments
        if ($LASTEXITCODE -ne 0) {
            throw "electron-builder failed with exit code $LASTEXITCODE."
        }

        if (-not $SkipVerification) {
            & $verificationPath -Target $Target -RequireTimestamp
        }
    } finally {
        Pop-Location
    }
} finally {
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
    $certificatePassword = $null
}

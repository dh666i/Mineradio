[CmdletBinding()]
param(
    [ValidateSet('nsis', 'dir')]
    [string]$Target = 'nsis',
    [switch]$RequireTimestamp
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'Authenticode signatures must be verified on Windows.'
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$package = Get-Content -Raw (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$distDir = Join-Path $projectRoot $package.build.directories.output
$appExecutable = Join-Path $distDir "win-unpacked\$($package.build.win.executableName).exe"
$elevateExecutable = Join-Path $distDir 'win-unpacked\resources\elevate.exe'
$targets = @($appExecutable)

if ($Target -eq 'nsis') {
    $targets += $elevateExecutable
    $installerName = $package.build.nsis.artifactName `
        -replace '\$\{version\}', [string]$package.version `
        -replace '\$\{ext\}', 'exe'
    $targets += Join-Path $distDir $installerName
}

$expectedSignerThumbprint = ''
foreach ($file in $targets) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Expected signed artifact was not found: $file"
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($null -eq $signature.SignerCertificate) {
        throw "No Authenticode signer certificate was found: $file"
    }
    if ($signature.Status -in @('NotSigned', 'HashMismatch', 'NotSupported')) {
        throw "Invalid Authenticode signature for ${file}: $($signature.StatusMessage)"
    }
    if ($RequireTimestamp -and $null -eq $signature.TimeStamperCertificate) {
        throw "The Authenticode signature does not include a timestamp: $file"
    }
    $signerThumbprint = [string]$signature.SignerCertificate.Thumbprint
    if ([string]::IsNullOrWhiteSpace($expectedSignerThumbprint)) {
        $expectedSignerThumbprint = $signerThumbprint
    } elseif ($signerThumbprint -ne $expectedSignerThumbprint) {
        throw "Signer certificate mismatch for ${file}. Expected $expectedSignerThumbprint, found $signerThumbprint."
    }

    Write-Host "Verified: $file"
    Write-Host "  Signer: $($signature.SignerCertificate.Subject)"
    Write-Host "  Trust status: $($signature.Status)"
    if ($null -ne $signature.TimeStamperCertificate) {
        Write-Host "  Timestamp authority: $($signature.TimeStamperCertificate.Subject)"
    }
}

Write-Host "All expected Windows artifacts contain Authenticode signatures from $expectedSignerThumbprint."

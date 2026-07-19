[CmdletBinding()]
param(
    [string]$Subject = 'CN=Mineradio',
    [ValidateRange(1, 10)]
    [int]$ValidYears = 3,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'Self-signed Windows code-signing certificates must be generated on Windows.'
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$secretDir = Join-Path $projectRoot '.cert'
$pfxPath = Join-Path $secretDir 'mineradio-self-signed.pfx'
$cerPath = Join-Path $secretDir 'mineradio-self-signed.cer'
$credentialPath = Join-Path $secretDir 'mineradio-signing-credential.xml'
$generatedPaths = @($pfxPath, $cerPath, $credentialPath)

if (-not $Force -and ($generatedPaths | Where-Object { Test-Path -LiteralPath $_ })) {
    throw "Signing material already exists in $secretDir. Use -Force to replace it."
}

New-Item -ItemType Directory -Path $secretDir -Force | Out-Null
if ($Force) {
    $generatedPaths | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object {
        Remove-Item -LiteralPath $_ -Force
    }
}

$passwordBytes = New-Object byte[] 36
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $random.GetBytes($passwordBytes)
} finally {
    $random.Dispose()
}

$plainPassword = [Convert]::ToBase64String($passwordBytes)
$securePassword = ConvertTo-SecureString -String $plainPassword -AsPlainText -Force
$certificate = $null

try {
    $certificate = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $Subject `
        -FriendlyName 'Mineradio local code signing' `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -HashAlgorithm SHA256 `
        -KeyAlgorithm RSA `
        -KeyLength 3072 `
        -KeyExportPolicy Exportable `
        -NotAfter (Get-Date).AddYears($ValidYears)

    Export-PfxCertificate `
        -Cert $certificate `
        -FilePath $pfxPath `
        -Password $securePassword `
        -ChainOption EndEntityCertOnly | Out-Null

    Export-Certificate -Cert $certificate -FilePath $cerPath -Type CERT | Out-Null

    $credential = [System.Management.Automation.PSCredential]::new('Mineradio', $securePassword)
    $credential | Export-Clixml -LiteralPath $credentialPath -Force
} finally {
    if ($null -ne $certificate) {
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -Force
    }
    $plainPassword = $null
}

Write-Host 'Created local self-signed code-signing material:'
Write-Host "  PFX: $pfxPath"
Write-Host "  Public certificate: $cerPath"
Write-Host "  Thumbprint: $($certificate.Thumbprint)"
Write-Host 'The encrypted credential is tied to the current Windows user and machine.'

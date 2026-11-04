# Exercises the real checksum/download control flow with local fixtures only.
# This is not a Windows API, DPAPI, Task Scheduler or browser installation test.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('gmoney-node-test-' + [Guid]::NewGuid().ToString('N'))
$savedArchitecture = $env:PROCESSOR_ARCHITECTURE
$savedWowArchitecture = $env:PROCESSOR_ARCHITEW6432
$script:manifestText = ''
$script:archiveFixture = Join-Path $testRoot 'fixture.zip'
$script:downloads = 0
$script:expanded = $false

function Get-GMoneyHome {
    param([string]$RequestedPath = '')
    return [IO.Path]::GetFullPath($RequestedPath)
}
function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
    if (-not $Uri.StartsWith('https://nodejs.org/dist/latest-v24.x/')) { throw 'Unexpected download host.' }
    $script:downloads++
    if ($Uri.EndsWith('/SHASUMS256.txt')) { [IO.File]::WriteAllText($OutFile, $script:manifestText) }
    else { Copy-Item -LiteralPath $script:archiveFixture -Destination $OutFile }
}
function Expand-Archive {
    param([string]$LiteralPath, [string]$DestinationPath)
    $script:expanded = $true
    throw 'Fixture expansion reached after verification.'
}
function Assert-GMoneyTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}
try {
    [void][IO.Directory]::CreateDirectory($testRoot)
    [IO.File]::WriteAllText($script:archiveFixture, 'Local checksum fixture, not an executable or ZIP.')
    $env:PROCESSOR_ARCHITECTURE = 'AMD64'
    $env:PROCESSOR_ARCHITEW6432 = ''
    $target = Join-Path $testRoot 'home'
    [void][IO.Directory]::CreateDirectory($target)

    $script:manifestText = ('0' * 64) + '  node-v24.0.0-win-x64.zip'
    $failure = ''
    try { Install-GMoneyPortableNode $target | Out-Null }
    catch { $failure = $_.Exception.Message }
    Assert-GMoneyTest ($failure -like '*failed its SHA256 checksum*') 'A corrupt download did not fail checksum verification.'
    Assert-GMoneyTest (-not $script:expanded) 'A corrupt download was expanded.'
    Assert-GMoneyTest ($script:downloads -eq 2) 'The corrupt-download fixture did not reach the expected download path.'
    Assert-GMoneyTest (-not (Test-Path -LiteralPath (Join-Path $target 'node'))) 'A corrupt download created a runtime directory.'

    $script:downloads = 0
    $script:manifestText = ('0' * 64) + '  ../node-v24.0.0-win-x64.zip'
    $failure = ''
    try { Install-GMoneyPortableNode $target | Out-Null }
    catch { $failure = $_.Exception.Message }
    Assert-GMoneyTest ($failure -like '*does not identify one supported Windows package*') 'A path-containing manifest filename was accepted.'
    Assert-GMoneyTest ($script:downloads -eq 1 -and -not $script:expanded) 'An invalid manifest downloaded or expanded a package.'

    $script:downloads = 0
    $hash = (Get-FileHash -LiteralPath $script:archiveFixture -Algorithm SHA256).Hash.ToLowerInvariant()
    $script:manifestText = $hash + '  node-v24.0.0-win-x64.zip'
    $failure = ''
    try { Install-GMoneyPortableNode $target | Out-Null }
    catch { $failure = $_.Exception.Message }
    Assert-GMoneyTest ($script:expanded -and $failure -eq 'Fixture expansion reached after verification.') 'A correctly verified download did not reach extraction.'
    Assert-GMoneyTest (@(Get-ChildItem -LiteralPath $target -Force).Count -eq 0) 'A failed bootstrap retained download staging files.'
    Write-Output 'PASS: corrupt archives and unsafe manifest names stop before extraction; verified archives reach extraction; staging is cleaned.'
} finally {
    $env:PROCESSOR_ARCHITECTURE = $savedArchitecture
    $env:PROCESSOR_ARCHITEW6432 = $savedWowArchitecture
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}

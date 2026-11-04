param([string]$ConnectorHome = '', [switch]$Prepare)
$ErrorActionPreference = 'Stop'
$workerMutex = $null
$ownsMutex = $false
$resultCode = 1
try {
    . (Join-Path $PSScriptRoot 'common.ps1')
    $localRoot = Get-GMoneyHome $ConnectorHome
    $workerMutex = [Threading.Mutex]::new($false, (Get-GMoneyMutexName))
    try { $ownsMutex = $workerMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { exit 0 }
    Set-GMoneyRuntimeEnvironment $localRoot
    $node = Get-GMoneyNode $localRoot
    $entry = Join-Path (Split-Path $PSScriptRoot -Parent) 'src\worker.mjs'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Worker is not installed.' }
    if ($Prepare) { & $node $entry --once --prepare }
    else { & $node $entry --once }
    $resultCode = $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine('G Money worker could not complete. Check Applications and the local connector setup; no credential was printed.')
    $resultCode = 1
} finally {
    if ($ownsMutex -and $null -ne $workerMutex) { $workerMutex.ReleaseMutex() }
    if ($null -ne $workerMutex) { $workerMutex.Dispose() }
}
exit $resultCode

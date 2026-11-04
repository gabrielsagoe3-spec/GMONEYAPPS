param([string]$ConnectorHome = '', [switch]$Quiet)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$localRoot = Get-GMoneyHome $ConnectorHome
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$launcher = Join-Path $PSScriptRoot 'run-worker.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'The worker launcher is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $localRoot 'connector.token') -PathType Leaf)) { throw 'Create the local encrypted connector credential first.' }
if ($localRoot.Contains('"') -or $launcher.Contains('"')) { throw 'Unexpected quotation mark in an installation path.' }
$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '" -ConnectorHome "' + $localRoot + '"'
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
# An omitted repetition duration repeats indefinitely; it does not stop tomorrow.
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$taskName = 'G Money Application Worker'
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Checks the private G Money application queue every five minutes while this Windows user is signed in. Never retries an uncertain submission automatically.' -Force | Out-Null
if (-not $Quiet) {
    Write-Host 'G Money checks queued applications every five minutes while you are signed into Windows.'
    Write-Host 'The hosted nightly report runs independently. A sleeping or signed-out PC cannot run the browser worker.'
}

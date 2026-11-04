param([string]$ConnectorHome = '', [switch]$SkipSchedule)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$installMutex = $null
$ownsMutex = $false
$downloadRoot = $null
$oldInstall = $null
$nextInstall = $null
$activeInstall = $null
$switchedInstall = $false
try {
    if ($env:OS -ne 'Windows_NT') { throw 'Run this installer in Windows PowerShell.' }
    if ([string]::IsNullOrWhiteSpace($ConnectorHome)) { $ConnectorHome = $env:GMONEY_CONNECTOR_HOME }
    if ([string]::IsNullOrWhiteSpace($ConnectorHome)) { $ConnectorHome = Join-Path $env:LOCALAPPDATA 'GMoneyConnector' }
    $localRoot = [IO.Path]::GetFullPath($ConnectorHome)
    if ($localRoot.TrimEnd('\') -eq [IO.Path]::GetPathRoot($localRoot).TrimEnd('\')) { throw 'Choose a dedicated connector directory, not a drive root.' }
    $homeMarker = Join-Path $localRoot '.gmoney-connector-home'
    if ((Test-Path -LiteralPath $localRoot) -and -not (Test-Path -LiteralPath $homeMarker -PathType Leaf)) {
        if (@(Get-ChildItem -LiteralPath $localRoot -Force -ErrorAction Stop).Count -gt 0) { throw 'The chosen connector directory already contains unrelated files. Choose a new dedicated directory.' }
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $installMutex = [Threading.Mutex]::new($false, ('Local\GMoneyConnector-' + $sid))
    try { $ownsMutex = $installMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'A G Money browser worker is running. Wait for it to finish before installing.' }
    $source = Split-Path $PSScriptRoot -Parent
    if (-not (Test-Path -LiteralPath (Join-Path $source 'package-lock.json') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $source 'src\server.mjs') -PathType Leaf)) {
        $downloadRoot = Join-Path ([IO.Path]::GetTempPath()) ('gmoney-install-' + [Guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($downloadRoot)
        $zipPath = Join-Path $downloadRoot 'source.zip'
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri 'https://github.com/gabrielsagoe3-spec/GMONEYAPPS/archive/refs/heads/main.zip' -OutFile $zipPath -UseBasicParsing
        Expand-Archive -LiteralPath $zipPath -DestinationPath (Join-Path $downloadRoot 'source')
        $source = Join-Path $downloadRoot 'source\GMONEYAPPS-main\connector'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $source 'package-lock.json') -PathType Leaf)) { throw 'The released connector package is incomplete.' }
    . (Join-Path $source 'scripts\common.ps1')
    Set-GMoneyPrivateDirectory $localRoot
    [IO.File]::WriteAllText($homeMarker, 'G Money Connector home v1', [Text.UTF8Encoding]::new($false))
    try { $node = Get-GMoneyNode $localRoot }
    catch { $node = Install-GMoneyPortableNode $localRoot }
    $npm = Join-Path (Split-Path $node -Parent) 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
        $node = Install-GMoneyPortableNode $localRoot
        $npm = Join-Path (Split-Path $node -Parent) 'npm.cmd'
    }
    Set-GMoneyPrivateDirectory (Join-Path $localRoot 'browser-profile')
    Set-GMoneyPrivateDirectory (Join-Path $localRoot 'browsers')
    $appRoot = Join-Path $localRoot 'app'
    [void][IO.Directory]::CreateDirectory($appRoot)
    $nextInstall = Join-Path $appRoot ('connector-next-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($nextInstall)
    foreach ($entry in @('package.json', 'package-lock.json', 'README.md', 'WINDOWS.md', 'Setup.cmd', 'src', 'scripts')) {
        $copySource = Join-Path $source $entry
        if (Test-Path -LiteralPath $copySource) { Copy-Item -LiteralPath $copySource -Destination $nextInstall -Recurse }
    }
    Set-GMoneyRuntimeEnvironment $localRoot
    Push-Location $nextInstall
    try {
        & $npm ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
        & $npm exec -- playwright install chromium
        if ($LASTEXITCODE -ne 0) { throw 'The dedicated Chromium browser download failed.' }
    } finally { Pop-Location }
    $credentialPath = Join-Path $localRoot 'connector.token'
    if (Test-Path -LiteralPath $credentialPath -PathType Leaf) { $tokenPrompt = 'Paste a new connector token (Enter keeps the current encrypted token)' }
    else { $tokenPrompt = 'Paste the connector token from your signed-in G Money Applications page' }
    $secret = Read-Host -Prompt $tokenPrompt -AsSecureString
    try {
        if ($secret.Length -gt 0) {
            $encrypted = ConvertFrom-SecureString -SecureString $secret
            [IO.File]::WriteAllText($credentialPath, $encrypted, [Text.UTF8Encoding]::new($false))
        } elseif (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) { throw 'A connector token is required.' }
    } finally { $secret.Dispose(); Remove-Variable secret -ErrorAction SilentlyContinue }
    $configPath = Join-Path $localRoot 'config.json'
    $previousPdf = ''
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        $previous = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
        if ($previous.PSObject.Properties.Name -contains 'resume_path') { $previousPdf = [string]$previous.resume_path }
    }
    $pdfPrompt = 'Full path to your actual resume PDF'
    if (-not [string]::IsNullOrWhiteSpace($previousPdf)) { $pdfPrompt += ' (Enter keeps the current file)' }
    $chosenPdf = (Read-Host -Prompt $pdfPrompt).Trim().Trim('"')
    if ([string]::IsNullOrWhiteSpace($chosenPdf)) { $chosenPdf = $previousPdf }
    $pdf = Get-Item -LiteralPath $chosenPdf -ErrorAction Stop
    if ($pdf.PSIsContainer -or $pdf.Extension -ine '.pdf' -or $pdf.Length -le 5 -or $pdf.Length -gt 10485760) { throw 'Choose an existing PDF smaller than 10 MiB.' }
    $stream = [IO.File]::OpenRead($pdf.FullName)
    try {
        $header = New-Object byte[] 5
        if ($stream.Read($header, 0, 5) -ne 5 -or [Text.Encoding]::ASCII.GetString($header) -ne '%PDF-') { throw 'The chosen file is not a PDF.' }
    } finally { $stream.Dispose() }
    $configuration = [ordered]@{ resume_path = $pdf.FullName }
    [IO.File]::WriteAllText($configPath, ($configuration | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    $activeInstall = Join-Path $appRoot 'connector'
    if (Test-Path -LiteralPath $activeInstall) {
        $oldInstall = Join-Path $appRoot ('connector-previous-' + [Guid]::NewGuid().ToString('N'))
        Move-Item -LiteralPath $activeInstall -Destination $oldInstall
    }
    try {
        Move-Item -LiteralPath $nextInstall -Destination $activeInstall
        $switchedInstall = $true
    } catch {
        if ($null -ne $oldInstall -and (Test-Path -LiteralPath $oldInstall)) { Move-Item -LiteralPath $oldInstall -Destination $activeInstall }
        throw
    }
    & $node (Join-Path $activeInstall 'src\check.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'The scoped connector credential could not be verified. Create a new Windows connector token on the Applications page and rerun setup.' }
    if (-not $SkipSchedule) { & (Join-Path $activeInstall 'scripts\install-task.ps1') -ConnectorHome $localRoot -Quiet }
    $launcher = Join-Path $activeInstall 'scripts\run-server.ps1'
    $quotedLauncher = "'" + $launcher.Replace("'", "''") + "'"
    $quotedHome = "'" + $localRoot.Replace("'", "''") + "'"
    Write-Host 'G Money connector installed for your Windows account. The token is encrypted with Windows DPAPI.'
    if ($SkipSchedule) { Write-Host 'Automatic application checks were not installed. Run scripts\install-task.ps1 to enable them.' }
    else { Write-Host 'Queued applications are checked every five minutes while you are signed into Windows.' }
    Write-Host 'To register the MCP with an installed Codex CLI, run:'
    Write-Host ('codex mcp add gmoney -- powershell.exe -NoProfile -ExecutionPolicy Bypass -File ' + $quotedLauncher + ' -ConnectorHome ' + $quotedHome)
    Write-Host 'Restart your MCP client after registration. This installer does not attach tools to an existing ChatGPT conversation.'
    Write-Host 'Nightly reports are created at 8:00 PM Houston time on the website. Windows notifications appear when this local worker is available and notifications are allowed.'
} catch {
    [Console]::Error.WriteLine('G Money setup did not finish: ' + $_.Exception.Message)
    [Console]::Error.WriteLine('No connector token was printed. You can safely rerun the installer after resolving the setup problem.')
    exit 1
} finally {
    if ($switchedInstall -and $null -ne $oldInstall -and (Test-Path -LiteralPath $oldInstall)) { Remove-Item -LiteralPath $oldInstall -Recurse -Force -ErrorAction SilentlyContinue }
    if ($null -ne $nextInstall -and (Test-Path -LiteralPath $nextInstall)) { Remove-Item -LiteralPath $nextInstall -Recurse -Force -ErrorAction SilentlyContinue }
    if ($null -ne $downloadRoot -and (Test-Path -LiteralPath $downloadRoot)) { Remove-Item -LiteralPath $downloadRoot -Recurse -Force -ErrorAction SilentlyContinue }
    if ($ownsMutex -and $null -ne $installMutex) { $installMutex.ReleaseMutex() }
    if ($null -ne $installMutex) { $installMutex.Dispose() }
}

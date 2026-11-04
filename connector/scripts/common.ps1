# Shared local helpers. This file never reads or prints connector credentials.
Set-StrictMode -Version Latest

function Get-GMoneyHome {
    param([string]$RequestedPath = '')
    if ($env:OS -ne 'Windows_NT') { throw 'This launcher requires Windows.' }
    if ([string]::IsNullOrWhiteSpace($RequestedPath)) { $RequestedPath = $env:GMONEY_CONNECTOR_HOME }
    if ([string]::IsNullOrWhiteSpace($RequestedPath)) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA is unavailable.' }
        $RequestedPath = Join-Path $env:LOCALAPPDATA 'GMoneyConnector'
    }
    return [IO.Path]::GetFullPath($RequestedPath)
}

function Get-GMoneyNode {
    param([string]$ConnectorHome = '')
    $localRoot = Get-GMoneyHome $ConnectorHome
    $candidates = @((Join-Path $localRoot 'node\node.exe'))
    $systemCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($null -ne $systemCommand) { $candidates += $systemCommand.Source }
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            $versionText = (& $candidate --version 2>$null | Out-String).Trim()
            if ($LASTEXITCODE -eq 0 -and $versionText -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { return $candidate }
        } catch { }
    }
    throw 'A supported Node.js runtime is unavailable. Run Setup.cmd to install the private runtime.'
}

function Install-GMoneyPortableNode {
    param([Parameter(Mandatory = $true)][string]$ConnectorHome)
    $localRoot = Get-GMoneyHome $ConnectorHome
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($architecture)) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -eq 'AMD64') { $nodeArchitecture = 'x64' }
    elseif ($architecture -eq 'ARM64') { $nodeArchitecture = 'arm64' }
    else { throw 'The private Node.js runtime requires 64-bit Windows (x64 or ARM64).' }
    $nodeRoot = Join-Path $localRoot 'node'
    if ((Test-Path -LiteralPath $nodeRoot) -and -not (Test-Path -LiteralPath (Join-Path $nodeRoot '.gmoney-node-runtime') -PathType Leaf)) {
        throw 'The connector node directory already contains an unrecognized runtime. Choose a clean connector installation directory.'
    }
    $downloadRoot = Join-Path $localRoot ('.node-download-' + [Guid]::NewGuid().ToString('N'))
    $previousNode = $null
    $installedNode = $false
    [void][IO.Directory]::CreateDirectory($downloadRoot)
    try {
        $baseUrl = 'https://nodejs.org/dist/latest-v24.x/'
        $manifestPath = Join-Path $downloadRoot 'SHASUMS256.txt'
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri ($baseUrl + 'SHASUMS256.txt') -OutFile $manifestPath -UseBasicParsing
        if ((Get-Item -LiteralPath $manifestPath).Length -gt 1048576) { throw 'The official Node.js checksum manifest is invalid.' }
        $entries = @()
        foreach ($line in [IO.File]::ReadAllLines($manifestPath)) {
            if ($line -match '^(?<checksum>[a-fA-F0-9]{64})\s+(?<filename>node-v24\.\d+\.\d+-win-(?<architecture>x64|arm64)\.zip)$' -and $Matches['architecture'] -eq $nodeArchitecture) {
                $entries += @{ checksum = $Matches['checksum'].ToLowerInvariant(); filename = $Matches['filename'] }
            }
        }
        if ($entries.Count -ne 1) { throw 'The official Node.js checksum manifest does not identify one supported Windows package.' }
        $entry = $entries[0]
        $archivePath = Join-Path $downloadRoot $entry.filename
        Invoke-WebRequest -Uri ($baseUrl + $entry.filename) -OutFile $archivePath -UseBasicParsing
        $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $entry.checksum) { throw 'The Node.js download failed its SHA256 checksum. Nothing was installed.' }
        $extractRoot = Join-Path $downloadRoot 'extracted'
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot
        $packageRoot = Join-Path $extractRoot ([IO.Path]::GetFileNameWithoutExtension($entry.filename))
        if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'node.exe') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $packageRoot 'npm.cmd') -PathType Leaf)) { throw 'The verified Node.js package is incomplete.' }
        [IO.File]::WriteAllText((Join-Path $packageRoot '.gmoney-node-runtime'), 'Official Node.js 24 portable runtime', [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $nodeRoot) {
            $previousNode = Join-Path $localRoot ('.node-previous-' + [Guid]::NewGuid().ToString('N'))
            Move-Item -LiteralPath $nodeRoot -Destination $previousNode
        }
        try {
            Move-Item -LiteralPath $packageRoot -Destination $nodeRoot
            $installedNode = $true
            $node = Get-GMoneyNode $localRoot
            if ($node -ne (Join-Path $nodeRoot 'node.exe')) { throw 'The private Node.js runtime could not start.' }
        } catch {
            if (Test-Path -LiteralPath $nodeRoot) { Remove-Item -LiteralPath $nodeRoot -Recurse -Force -ErrorAction SilentlyContinue }
            if ($null -ne $previousNode -and (Test-Path -LiteralPath $previousNode)) { Move-Item -LiteralPath $previousNode -Destination $nodeRoot }
            $installedNode = $false
            throw
        }
        return $node
    } finally {
        if ($installedNode -and $null -ne $previousNode -and (Test-Path -LiteralPath $previousNode)) { Remove-Item -LiteralPath $previousNode -Recurse -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $downloadRoot) { Remove-Item -LiteralPath $downloadRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

function Set-GMoneyPrivateDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    [void][IO.Directory]::CreateDirectory($Path)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetOwner($identity.User)
    $security.SetAccessRuleProtection($true, $false)
    $rights = [Security.AccessControl.FileSystemRights]::FullControl
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagate = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity.User, $rights, $inherit, $propagate, $allow)
    [void]$security.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $security -ErrorAction Stop
}

function Get-GMoneyMutexName {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    return 'Local\GMoneyConnector-' + $sid
}

function Set-GMoneyRuntimeEnvironment {
    param([Parameter(Mandatory = $true)][string]$ConnectorHome)
    $env:GMONEY_CONNECTOR_HOME = $ConnectorHome
    $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $ConnectorHome 'browsers'
    $privateNode = Join-Path $ConnectorHome 'node'
    if (Test-Path -LiteralPath (Join-Path $privateNode 'node.exe') -PathType Leaf) { $env:Path = $privateNode + ';' + $env:Path }
}

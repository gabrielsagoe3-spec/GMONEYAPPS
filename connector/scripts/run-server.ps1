param([string]$ConnectorHome = '')
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'common.ps1')
    $localRoot = Get-GMoneyHome $ConnectorHome
    Set-GMoneyRuntimeEnvironment $localRoot
    $node = Get-GMoneyNode $localRoot
    $entry = Join-Path (Split-Path $PSScriptRoot -Parent) 'src\server.mjs'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'MCP server is not installed.' }
    # Windows PowerShell 5.1 otherwise uses OEM/native pipeline encodings, which
    # can corrupt non-ASCII JSON text in MCP requests and responses.
    $utf8 = [Text.UTF8Encoding]::new($false)
    [Console]::InputEncoding = $utf8
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
    # Preserve stdin/stdout for the MCP protocol. Never print banners here.
    & $node $entry
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine('G Money MCP could not start. Check the Windows setup and local credential; no credential was printed.')
    exit 1
}

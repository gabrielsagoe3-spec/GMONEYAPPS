param([Parameter(Mandatory = $true)][string]$SummaryFile)
$ErrorActionPreference = 'Stop'
try {
    if ($env:OS -ne 'Windows_NT') { throw 'Windows is required.' }
    $file = Get-Item -LiteralPath $SummaryFile -ErrorAction Stop
    if ($file.PSIsContainer -or $file.Length -gt 8192) { throw 'Invalid notification file.' }
    $summary = [IO.File]::ReadAllText($file.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $title = [string]$summary.title
    $body = [string]$summary.body
    $url = [string]$summary.url
    if ([string]::IsNullOrWhiteSpace($title) -or $title.Length -gt 120 -or $body.Length -gt 800) { throw 'Invalid notification text.' }
    if ($url -ne 'https://gabrielsagoe3-spec.github.io/GMONEYAPPS/#applications') { throw 'Invalid report destination.' }
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml('<toast activationType="protocol"><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
    $xml.DocumentElement.SetAttribute('launch', $url)
    $nodes = $xml.SelectNodes('//text')
    $nodes.Item(0).AppendChild($xml.CreateTextNode($title)) | Out-Null
    $nodes.Item(1).AppendChild($xml.CreateTextNode($body)) | Out-Null
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell').Show($toast)
    exit 0
} catch {
    [Console]::Error.WriteLine('Windows could not display the G Money notification. The private report remains available in Applications.')
    exit 1
}

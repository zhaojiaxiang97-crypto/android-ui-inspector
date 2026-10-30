param(
    [ValidateSet('Development', 'Unpacked')]
    [string]$Target = 'Development'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$relativeDirectory = if ($Target -eq 'Development') { 'node_modules\electron\dist' } else { 'release\win-unpacked' }
$expectedExe = if ($Target -eq 'Development') { 'electron.exe' } else { 'Android UI Inspector.exe' }
$runtimeDirectory = Get-Item -LiteralPath (Join-Path $projectDirectory $relativeDirectory)
if (-not $runtimeDirectory.PSIsContainer -or ($runtimeDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Expected a physical Electron runtime directory.'
}
$expectedDirectory = [IO.Path]::GetFullPath((Join-Path $projectDirectory $relativeDirectory))
if ($runtimeDirectory.FullName -ne $expectedDirectory -or -not (Test-Path -LiteralPath (Join-Path $runtimeDirectory.FullName $expectedExe) -PathType Leaf)) {
    throw 'Runtime directory validation failed.'
}

$sid = [Security.Principal.SecurityIdentifier]::new('S-1-15-2-2')
$rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$acl = Get-Acl -LiteralPath $runtimeDirectory.FullName
$matching = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
    $_.IdentityReference.Value -eq $sid.Value -and
    $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
    ($_.FileSystemRights -band $rights) -eq $rights -and
    ($_.InheritanceFlags -band $inheritance) -eq $inheritance -and
    $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None
})

$backupPath = $null
if ($matching.Count -eq 0) {
    $backupDirectory = Join-Path $projectDirectory '.benchmarks\acl'
    [IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
    $backupPath = Join-Path $backupDirectory (('{0}-{1}.json' -f $Target.ToLowerInvariant(), [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ')))
    $backup = [ordered]@{
        target = $runtimeDirectory.FullName
        createdAt = [DateTime]::UtcNow.ToString('o')
        accessSddl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
        addedSid = $sid.Value
        addedRights = 'ReadAndExecute'
    } | ConvertTo-Json
    [IO.File]::WriteAllText($backupPath, $backup, [Text.UTF8Encoding]::new($false))
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $runtimeDirectory.FullName -AclObject $acl
}

$executableAcl = Get-Acl -LiteralPath (Join-Path $runtimeDirectory.FullName $expectedExe)
$readable = @($executableAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
    $_.IdentityReference.Value -eq $sid.Value -and
    $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
    ($_.FileSystemRights -band $rights) -eq $rights
})
if ($readable.Count -eq 0) { throw 'The executable did not inherit restricted-package read/execute access.' }
[ordered]@{ target = $runtimeDirectory.FullName; changed = ($matching.Count -eq 0); sid = $sid.Value; rights = 'ReadAndExecute'; backup = $backupPath } | ConvertTo-Json -Compress

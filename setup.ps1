$ErrorActionPreference = 'Stop'
$target = Join-Path $PSScriptRoot '.env'
Write-Host 'Santa''s Sketchbook - connect your OpenAI account'
Write-Host 'Create a project API key at https://platform.openai.com/api-keys'
Write-Host 'The key stays in this project''s Git-ignored .env file. It is never sent to the browser.'
$secureKey = Read-Host 'Paste your OpenAI API key (hidden)' -AsSecureString
$pointer = [IntPtr]::Zero
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ($plainKey -notmatch '^sk-[A-Za-z0-9_-]{20,}$') { throw 'That does not look like an OpenAI API key. No changes saved.' }
    $lines = @()
    if (Test-Path -LiteralPath $target) { $lines = @(Get-Content -LiteralPath $target | Where-Object { $_ -notmatch '^OPENAI_API_KEY\s*=' }) }
    $lines += 'OPENAI_API_KEY=' + $plainKey
    [IO.File]::WriteAllLines($target, $lines, [Text.UTF8Encoding]::new($false))
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($identity)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow'))
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'), 'FullControl', 'Allow'))
    Set-Acl -LiteralPath $target -AclObject $acl
    Write-Host 'Saved. Use Grown-ups > Check connection again in the app.'
    Write-Host 'Run npm run check:account to check whether both models appear for this key.'
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $plainKey = $null
    $lines = $null
    $secureKey.Dispose()
}

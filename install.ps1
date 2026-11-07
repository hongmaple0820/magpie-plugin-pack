# 一键把 magpie-plugin-pack/plugins 下所有插件加进 magpie（文件夹就地加载）。
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Magpie "D:\Program Files\magpie-windows-amd64.exe"
param(
    [string]$Magpie = ""
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# 1) 找 magpie
$candidates = @()
if ($Magpie -and (Test-Path -LiteralPath $Magpie)) { $candidates += $Magpie }
$fromPath = Get-Command magpie -ErrorAction SilentlyContinue
if ($fromPath) { $candidates += $fromPath.Source }
$candidates += @(
    "$env:ProgramFiles\magpie-windows-amd64.exe",
    "${env:ProgramFiles(x86)}\magpie-windows-amd64.exe",
    "$env:LOCALAPPDATA\magpie\magpie-windows-amd64.exe"
)
$exe = $null
foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { $exe = $c; break }
}
if (-not $exe) {
    Write-Host '找不到 magpie，请用 -Magpie 指定完整路径：' -ForegroundColor Red
    Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Magpie "D:\Program Files\magpie-windows-amd64.exe"'
    exit 1
}
Write-Host ('magpie: ' + $exe)

# 2) 遍历 plugins/*/package.json
$plugins = Get-ChildItem -Path (Join-Path $root 'plugins') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') }

if (-not $plugins) {
    Write-Host 'plugins/ 下没有可安装的插件目录（每个插件需含 package.json）' -ForegroundColor Yellow
    exit 0
}

$failed = @()
foreach ($p in $plugins) {
    Write-Host ''
    Write-Host ('==> 添加 ' + $p.Name) -ForegroundColor Cyan
    & $exe plugin add $p.FullName
    if ($LASTEXITCODE -ne 0) { $failed += $p.Name }
}

Write-Host ''
if ($failed.Count -eq 0) {
    Write-Host '全部完成。已安装的插件会重复添加失败，属正常（已在列表中）。' -ForegroundColor Green
    Write-Host '下一步：magpie plugin login PROVIDER 登录；GUI 里到 插件 → 已安装 打开并登录。'
} else {
    Write-Host ('以下插件添加失败：' + ($failed -join ', ')) -ForegroundColor Red
    Write-Host '可手动执行：magpie plugin add 插件目录' -ForegroundColor Yellow
    exit 1
}

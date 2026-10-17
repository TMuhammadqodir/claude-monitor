# Starts Claude Monitor's server whenever this Windows computer starts, without a window, even before anyone
# signs in. Run once in PowerShell opened as administrator:
#
#   powershell -ExecutionPolicy Bypass -File scripts\autostart-windows.ps1           turn on
#   powershell -ExecutionPolicy Bypass -File scripts\autostart-windows.ps1 -Remove   turn off
#
# The server writes what it says (the setup code too) to data\server.log.

#Requires -RunAsAdministrator
param([switch]$Remove, [int]$Port = 4318)

$ErrorActionPreference = 'Stop'
$name = 'Claude Monitor'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "OK: '$name' endi o'zi ishga tushmaydi."
  exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null

# cmd keeps the server's output in a file: a task without a window has nowhere else to show it.
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $root `
  -Argument "/c set PORT=$Port&& `"$node`" server.mjs >> data\server.log 2>&1"
$trigger = New-ScheduledTaskTrigger -AtStartup
# S4U: runs as this user without keeping a password, whether anyone is signed in or not (the server needs
# only this computer's files and network).
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
# Started again after a crash; never stopped for running long; on a laptop, on battery too.
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name

# The firewall lets the other computers (home network, Tailscale) reach the port.
if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
}

Write-Host "OK: '$name' har yoqilganda o'zi ishga tushadi va hozir ishga tushirildi."
Write-Host "    Panel: http://localhost:$Port   Yozuvlar: $root\data\server.log"

@echo off
echo Probeert Java bridge op poort 3210 te stoppen...
powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if($p){Stop-Process -Id $p -Force; Write-Host ('Gestopt PID '+$p)} else {Write-Host 'Geen listener op 3210 gevonden.'}"
pause

$task = 'NexoTICentral'
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName 'Central de Operações de TI' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
# Os dados e backups em ProgramData são preservados após a desinstalação.

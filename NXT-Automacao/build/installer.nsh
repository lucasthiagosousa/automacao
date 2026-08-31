!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Central de Operações de TI"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Central de Operações de TI" dir=in action=allow protocol=TCP localport=3000 profile=domain,private'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Central de Operações de TI"'
!macroend

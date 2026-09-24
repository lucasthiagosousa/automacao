!macro customInit
  nsExec::ExecToLog 'taskkill /F /IM "Central de Operações de TI.exe"'
  nsExec::ExecToLog 'sc.exe stop "CentralOperacoesTI"'
  Sleep 1500
  nsExec::ExecToLog 'sc.exe delete "CentralOperacoesTI"'
  Sleep 1500
!macroend

!macro customInstall
  CreateDirectory "$PROGRAMDATA\NexoTI"
  CreateDirectory "$PROGRAMDATA\NexoTI\CentralOperacoes"
  CreateDirectory "$PROGRAMDATA\NexoTI\CentralOperacoes\dados"
  CreateDirectory "$PROGRAMDATA\NexoTI\CentralOperacoes\logs"

  nsExec::ExecToLog 'icacls "$PROGRAMDATA\NexoTI\CentralOperacoes" /grant *S-1-5-32-545:(OI)(CI)M /T /C'

  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Central de Operações de TI"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Central de Operações de TI" dir=in action=allow protocol=TCP localport=3000 profile=domain,private'

  nsExec::ExecToLog 'sc.exe create "CentralOperacoesTI" binPath= "$INSTDIR\CentralOperacoesTI-Service.exe" start= auto DisplayName= "Central de Operações de TI"'
  nsExec::ExecToLog 'sc.exe description "CentralOperacoesTI" "Servidor 24/7 da Central de Operações de TI"'
  nsExec::ExecToLog 'sc.exe failure "CentralOperacoesTI" reset= 3600 actions= restart/10000/restart/30000/restart/60000'
  nsExec::ExecToLog 'sc.exe failureflag "CentralOperacoesTI" 1'
  nsExec::ExecToLog 'sc.exe start "CentralOperacoesTI"'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'sc.exe stop "CentralOperacoesTI"'
  Sleep 1500
  nsExec::ExecToLog 'sc.exe delete "CentralOperacoesTI"'
  nsExec::ExecToLog 'taskkill /F /IM "Central de Operações de TI.exe"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Central de Operações de TI"'

  ; Dados e histórico em ProgramData são preservados intencionalmente.
!macroend

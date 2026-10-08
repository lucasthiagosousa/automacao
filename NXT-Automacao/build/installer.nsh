!macro customInit
  nsExec::ExecToLog 'taskkill /F /IM "Central de Operações de TI.exe"'
  nsExec::ExecToLog 'sc.exe stop "CentralOperacoesTI"'
  Sleep 1500
  nsExec::ExecToLog 'sc.exe delete "CentralOperacoesTI"'
  Sleep 1500
!macroend

!macro customInstall
  ReadEnvStr $0 "ProgramData"
  CreateDirectory "$0\NexoTI"
  CreateDirectory "$0\NexoTI\CentralOperacoes"
  CreateDirectory "$0\NexoTI\CentralOperacoes\dados"
  CreateDirectory "$0\NexoTI\CentralOperacoes\logs"

  nsExec::ExecToLog 'icacls "$0\NexoTI\CentralOperacoes" /grant *S-1-5-32-545:(OI)(CI)M /T /C'

  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Central de Operações de TI"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Central de Operações de TI" dir=in action=allow protocol=TCP localport=3000 profile=domain,private'

  nsExec::ExecToLog '"$INSTDIR\CentralOperacoesTI-Service.exe" install'
  nsExec::ExecToLog 'sc.exe config "CentralOperacoesTI" start= auto'
  nsExec::ExecToLog 'sc.exe failure "CentralOperacoesTI" reset= 3600 actions= restart/10000/restart/30000/restart/60000'
  nsExec::ExecToLog 'sc.exe failureflag "CentralOperacoesTI" 1'
  nsExec::ExecToLog '"$INSTDIR\CentralOperacoesTI-Service.exe" start'
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$INSTDIR\CentralOperacoesTI-Service.exe" stop'
  Sleep 1500
  nsExec::ExecToLog '"$INSTDIR\CentralOperacoesTI-Service.exe" uninstall'
  nsExec::ExecToLog 'sc.exe delete "CentralOperacoesTI"'
  nsExec::ExecToLog 'taskkill /F /IM "Central de Operações de TI.exe"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Central de Operações de TI"'

  ; Dados e histórico em ProgramData são preservados intencionalmente.
!macroend

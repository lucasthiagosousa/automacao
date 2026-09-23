!macro customInit
  nsExec::ExecToLog 'taskkill /F /IM "Central de Operações de TI.exe"'
!macroend

!macro customInstall
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\install-service.ps1" -Executable "$INSTDIR\Central de Operações de TI.exe"'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\uninstall-service.ps1"'
!macroend

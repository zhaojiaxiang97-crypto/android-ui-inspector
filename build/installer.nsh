!macro customInstall
  ; Grant only read/execute to Windows restricted application packages.
  ; Keep existing permissions and the renderer sandbox intact.
  nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /Q'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "Unable to prepare sandbox runtime permissions: $0 $1"
    MessageBox MB_OK|MB_ICONSTOP "Windows could not prepare the application folder for sandboxed rendering. Please reinstall to a writable application folder. Error: $0" /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}
!macroend

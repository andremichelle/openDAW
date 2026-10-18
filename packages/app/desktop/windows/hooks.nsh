; the engine's plugin scan cache lives outside the app's data folders (scan.rs cache_file)
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$LOCALAPPDATA\openDAW"
  ${EndIf}
!macroend

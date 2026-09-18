!macro removeLegacyMailtoHandler
  ; Builds up to 4.0.3 let Electron write a legacy HKCU\Software\Classes\mailto
  ; command, which duplicates the modern ProgID registration and would dangle after
  ; an uninstall. Remove it, but only while it is still exactly the command those
  ; builds wrote — never someone else's handler.
  ; The legacy handler was written by Electron at runtime, which always uses HKCU —
  ; SHCTX would be HKLM on a per-machine build and would miss it.
  ReadRegStr $0 HKCU "Software\Classes\mailto\shell\open\command" ""
  StrCmp $0 '"$INSTDIR\Inboxora.exe" "%1"' 0 +2
  DeleteRegKey HKCU "Software\Classes\mailto"
!macroend

!macro customInstall
  ; Register as an email client so Inboxora is listed under Settings -> Default apps
  ; -> Email, and as the mailto: handler so the user can pick it for email links.
  ; Windows 10/11 still require the user to confirm the default in Settings.
  WriteRegStr SHCTX "Software\RegisteredApplications" "Inboxora" "Software\Clients\Mail\Inboxora\Capabilities"

  WriteRegStr SHCTX "Software\Clients\Mail\Inboxora" "" "Inboxora"
  WriteRegStr SHCTX "Software\Clients\Mail\Inboxora\Capabilities" "ApplicationName" "Inboxora"
  WriteRegStr SHCTX "Software\Clients\Mail\Inboxora\Capabilities" "ApplicationDescription" "A self-hosted, unified webmail client."
  WriteRegStr SHCTX "Software\Clients\Mail\Inboxora\Capabilities" "ApplicationIcon" "$INSTDIR\Inboxora.exe,0"
  WriteRegStr SHCTX "Software\Clients\Mail\Inboxora\Capabilities\URLAssociations" "mailto" "Inboxora.mailto"

  WriteRegStr SHCTX "Software\Classes\Inboxora.mailto" "" "URL:Inboxora MailTo Protocol"
  WriteRegStr SHCTX "Software\Classes\Inboxora.mailto" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\Inboxora.mailto\DefaultIcon" "" "$INSTDIR\Inboxora.exe,0"
  WriteRegStr SHCTX "Software\Classes\Inboxora.mailto\shell\open\command" "" '"$INSTDIR\Inboxora.exe" "%1"'

  !insertmacro removeLegacyMailtoHandler

  ; Tell the shell the associations changed (SHCNE_ASSOCCHANGED). Without this the
  ; Default apps page can keep showing the state from before the install.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Inboxora"
  DeleteRegKey SHCTX "Software\Clients\Mail\Inboxora"
  DeleteRegKey SHCTX "Software\Classes\Inboxora.mailto"
  !insertmacro removeLegacyMailtoHandler
  ; Drop the association from the shell's cache as well.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend

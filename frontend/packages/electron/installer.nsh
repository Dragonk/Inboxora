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
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Inboxora"
  DeleteRegKey SHCTX "Software\Clients\Mail\Inboxora"
  DeleteRegKey SHCTX "Software\Classes\Inboxora.mailto"
!macroend

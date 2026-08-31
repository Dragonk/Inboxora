!macro customInstall
  WriteRegStr SHCTX "Software\RegisteredApplications" "Inboxora" "Software\Clients\Mail\Inboxora\Capabilities"

  WriteRegStr SHCTX "Software\Clients\Mail\Inboxora" "" "Inboxora"
  WriteRegStr SHCTX "Software\Clients\Mail\Inboxora\Capabilities" "ApplicationName" "Inboxora"
  WriteRegStr SHCTX "Software\Clients\Mail\Inboxora\Capabilities" "ApplicationDescription" "A self-hosted, unified webmail client."
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

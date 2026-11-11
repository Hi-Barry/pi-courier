' pi-courier out-of-tree restart helper (spec #331).
'
' Launch (detached, unref'd -- this script must survive the bridge process being
' killed, so it is spawned with no handle back into the bridge tree):
'   wscript.exe //nologo "<install>\deploy\windows\restart-hidden.vbs" [taskname]
'
' Why this exists: on Windows the /update flow ends with "restart manually"
' because the bridge cannot safely restart itself -- schtasks /end kills the
' task's process tree, and any restart command spawned from inside that tree
' dies with it (the watchdog can bounce the bridge only because it lives in a
' DIFFERENT task). This helper runs as a detached wscript and replays the
' watchdog's proven recipe:
'   1. taskkill /F on the heartbeat PID -- NOTE: deliberately WITHOUT /T.
'      This wscript IS a child of the bridge process (detached only removes the
'      console, not the parent-child link); /T would terminate THIS HELPER
'      before it ever reaches /end and /run, so the bridge would never come
'      back. Kill the bridge PID alone, then let /end clean up the task
'      instance and /run start the new one.
'      schtasks /end alone does NOT kill node (real machine 2026-11-11:
'      "terminated" reported, node kept running, single-instance lock held,
'      the new instance died on the lock), hence the explicit taskkill /F.
'   2. schtasks /change /enable /tn <task> -- best effort; a disabled task
'      cannot be /run (the upgrade window disables the WATCHDOG, not the
'      bridge task, but a manually disabled task is a real deployment).
'   3. schtasks /end /tn <task>   -- marks the instance stopped.
'   4. schtasks /run /tn <task>   -- starts the new instance (new code on disk).
'
' The heartbeat PID kill is best effort: a dead/stale PID just fails the
' taskkill and the sequence continues; PID reuse inside the ~30s heartbeat
' window is accepted (same trade-off the watchdog already makes).
'
' ASCII-only on purpose: WSH reads .vbs in the system ANSI codepage and both
' the 5.1 console and WSH choke on non-ASCII without a trustworthy BOM
' (2026-11-03 real-machine lesson, see watchdog-windows.ps1).
Option Explicit
Dim shell, fso, taskName, heartbeatPath, content, pid, re, matches
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count >= 1 Then
  taskName = WScript.Arguments(0)
Else
  taskName = "pi-courier"
End If

' Let the bridge finish its receipts (reply awaits) and the spawn call return
' before anything gets killed.
WScript.Sleep 3000

pid = ""
heartbeatPath = shell.ExpandEnvironmentStrings("%APPDATA%") & "\pi-courier\state\heartbeat.json"
If fso.FileExists(heartbeatPath) Then
  content = fso.OpenTextFile(heartbeatPath, 1).ReadAll
  Set re = New RegExp
  re.Pattern = """pid""\s*:\s*(\d+)"
  If re.Test(content) Then
    Set matches = re.Execute(content)
    pid = matches(0).SubMatches(0)
  End If
End If

If pid <> "" Then
  shell.Run "taskkill /F /PID " & pid, 0, True
End If

' /change /enable is best effort: without it a task that was disabled
' (manually, or by an operator during maintenance) fails /run silently.
shell.Run "schtasks /change /enable /tn " & taskName, 0, True
shell.Run "schtasks /end /tn " & taskName, 0, True
shell.Run "schtasks /run /tn " & taskName, 0, True

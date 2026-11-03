' Hidden wrapper for the pi-courier watchdog scheduled task (spec #258 follow-up).
' Same rationale as run-hidden.vbs: an InteractiveToken task allocates a VISIBLE
' console every minute; this hides it while staying in the interactive session.
' If you can elevate, prefer LogonType S4U instead (runs headless even without
' logon) - plain Register-ScheduledTask with an S4U principal is access-denied
' from a non-elevated context (2026-11-03 real machine).
' Task action: wscript.exe //nologo "<this file>"
Option Explicit
Dim shell, ps, arg
Set shell = CreateObject("WScript.Shell")
ps = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
arg = "-NoProfile -ExecutionPolicy Bypass -File """ & shell.ExpandEnvironmentStrings("%APPDATA%") & "\npm\node_modules\pi-courier\deploy\watchdog\watchdog-windows.ps1"" -TaskName pi-courier"
shell.Run """" & ps & """ " & arg, 0, False

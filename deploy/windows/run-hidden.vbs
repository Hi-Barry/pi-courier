' pi-courier hidden-console launcher for Windows Task Scheduler (spec #258 follow-up).
'
' Why this exists: an InteractiveToken scheduled task allocates a VISIBLE console
' window on the user desktop. For the long-running bridge that means a permanent
' black window; this launcher starts the bridge with window style 0 (hidden) while
' KEEPING the interactive session, so agent-spawned GUI processes (browsers, UAC
' prompts, desktop automation) still appear on the real desktop. Do NOT switch the
' bridge task to S4U/session 0 for the same reason.
'
' Task action:
'   wscript.exe //nologo "<install>\deploy\windows\run-hidden.vbs"
'
' The log path encodes the frozen win32 layout (spec #258): %APPDATA%\pi-courier.
' ASCII-only on purpose: WSH reads .vbs in the system ANSI codepage and both the
' 5.1 console and WSH choke on non-ASCII without a trustworthy BOM (2026-11-03
' real-machine lesson, see watchdog-windows.ps1).
Option Explicit
Dim shell, logDir
Set shell = CreateObject("WScript.Shell")
logDir = shell.ExpandEnvironmentStrings("%APPDATA%") & "\pi-courier\state\logs"
shell.Run "cmd /c if not exist """ & logDir & """ mkdir """ & logDir & """", 0, True
shell.Run "cmd /c pi-courier run >> """ & logDir & "\run.log"" 2>&1", 0, False

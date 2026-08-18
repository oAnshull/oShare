Option Explicit

Dim shell, files, scriptPath, powershellPath, command, quote
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count = 0 Then WScript.Quit 1

quote = Chr(34)
scriptPath = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "UploadToCloud.ps1")
powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = quote & powershellPath & quote & " -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & quote & scriptPath & quote & " " & quote & WScript.Arguments(0) & quote

shell.Run command, 0, False

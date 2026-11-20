' Boot-time warmup for the yuno TTS engine (GPT-SoVITS).
' Calls start-engine.ps1 living NEXT TO this file, so the plugin can be installed anywhere.
' Keep this file pure ASCII: cscript chokes on non-ASCII content.
Dim fso, here, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\start-engine.ps1"
If Not fso.FileExists(ps1) Then WScript.Quit 0
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
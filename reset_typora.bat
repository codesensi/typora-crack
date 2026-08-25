@echo off

rem Delete registry key
reg delete HKEY_CURRENT_USER\Software\Typora /f

rem Delete profile.data
if defined AppData (
    del /f "%AppData%\Typora\profile.data" 2>nul
) else (
    del /f "C:\Users\%USERNAME%\AppData\Roaming\Typora\profile.data" 2>nul
)

echo Done.
pause

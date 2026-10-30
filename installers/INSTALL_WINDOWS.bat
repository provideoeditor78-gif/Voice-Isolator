@echo off
setlocal enableextensions
title Voice Separator - Install
set "SRC=%~dp0panel"
set "DEST=%APPDATA%\Adobe\CEP\extensions\com.yourname.voicesep"

echo ==================================================
echo   Voice Separator - Install
echo ==================================================
echo.
echo Pehle After Effects aur Premiere Pro BAND kar dein.
pause

for %%v in (9 10 11 12) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy "%SRC%" "%DEST%\" /E /I /Y /Q >nul
if errorlevel 1 goto fail

echo.
echo ==================================================
echo   INSTALL COMPLETE
echo   After Effects / Premiere kholein:
echo   Window ^> Extensions ^> Voice Separator
echo   Pehli dafa "Download essential files" button dabayein.
echo ==================================================
pause
exit /b 0

:fail
echo Copy fail hui. Dubara try karein.
pause
exit /b 1

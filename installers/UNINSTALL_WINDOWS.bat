@echo off
set "DEST=%APPDATA%\Adobe\CEP\extensions\com.yourname.voicesep"
if exist "%DEST%" rmdir /s /q "%DEST%"
if exist "%APPDATA%\VoiceSeparator" rmdir /s /q "%APPDATA%\VoiceSeparator"
echo Voice Separator (aur downloaded files) remove ho gaye.
pause

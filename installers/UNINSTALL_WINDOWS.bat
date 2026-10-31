@echo off
set "DEST=%APPDATA%\Adobe\CEP\extensions\com.asadfx.voiceisolator"
set "OLD=%APPDATA%\Adobe\CEP\extensions\com.yourname.voicesep"
if exist "%OLD%" rmdir /s /q "%OLD%"
if exist "%DEST%" rmdir /s /q "%DEST%"
if exist "%APPDATA%\VoiceSeparator" rmdir /s /q "%APPDATA%\VoiceSeparator"
echo Voice Isolator (aur downloaded files) remove ho gaye.
pause

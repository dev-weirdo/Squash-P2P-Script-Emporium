@echo off
setlocal enabledelayedexpansion

:: input directory
set /p "inputDir=Enter the directory path: "

:: check if directory exists
if not exist "%inputDir%" (
    echo Directory does not exist!
    exit /b
)

:: process .flac files in all subdirectories
for /r "%inputDir%" %%F in (*.flac) do (
    echo Processing "%%F"...

    set "filename=%%~nF"
    set "filepath=%%~dpF"
    set outputname=!filename:audio_=!
    sox.exe "%%~F" -S -n spectrogram -x 4000 -y 513 -z 120 -w Kaiser -t "!outputname!" -o "!filepath!!outputname!_spectrogram.png"
)

pause

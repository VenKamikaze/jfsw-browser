@ECHO OFF
REM Generator for version-auto.c on Windows

git.exe --version >NUL 2>&1
IF %ERRORLEVEL% EQU 0 (
    FOR /F %%G IN ('git.exe describe --always') DO ECHO const char *game_version = "%%G";
) ELSE (
    ECHO const char *game_version = "git error";
)
ECHO const char *game_date = __DATE__;
ECHO const char *game_time = __TIME__;
REM brief 05b: no build id here (the "different build" line of a network game is then not shown)
ECHO const char *game_build_id = "";

EXIT /B 0

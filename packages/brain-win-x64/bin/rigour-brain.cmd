@echo off
where llama-cli >NUL 2>NUL
if %ERRORLEVEL% EQU 0 (
  llama-cli %*
  exit /b %ERRORLEVEL%
)
echo rigour-brain is not bundled in this build. Install llama-cli or republish with binary assets. 1>&2
exit /b 1

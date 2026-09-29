@echo off
where llama-cli >NUL 2>NUL
if %ERRORLEVEL% EQU 0 (
  llama-cli %*
  exit /b %ERRORLEVEL%
)
echo rigour-brain is a placeholder. Run `rigour deep pull` to install the llama.cpp engine, or put llama-cli on PATH. 1>&2
exit /b 1

@echo off
cd /d "%~dp0"
echo Building SafeRoute C++ route engine...
g++ cpp_engine\route_engine.cpp -o cpp_engine\route_engine.exe -std=c++14 -O2
if errorlevel 1 (
  echo.
  echo BUILD FAILED. Check that MinGW-w64 g++ is installed and added to PATH.
  pause
  exit /b 1
)
echo.
echo Build successful: cpp_engine\route_engine.exe
pause

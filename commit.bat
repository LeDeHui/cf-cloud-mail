@echo off
setlocal

rem 切到 bat 所在目录（bat 必须放在仓库根目录）
cd /d "%~dp0"
if errorlevel 1 (
    echo [ERROR] 切换目录失败
    pause
    exit /b 1
)

rem 获取时间戳
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TS=%%i"
if "%TS%"=="" (
    echo [ERROR] 获取时间戳失败
    pause
    exit /b 1
)

rem 暂存
git add .

rem 判断有没有暂存的变更
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "auto commit %TS%"
    if errorlevel 1 (
        echo [ERROR] commit 失败
        pause
        exit /b 1
    )
) else (
    echo [INFO] no changes to commit
)

rem 推送
git push origin main
if errorlevel 1 (
    echo [ERROR] push failed
    pause
    exit /b 1
)

echo [OK] done: %TS%
pause
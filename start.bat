@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [检查] 检查 Node.js 环境...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先在官网安装 Node.js (建议 LTS 版本)!
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [提示] 检测到首次运行，正在安装依赖包...
    call npm install
)

if not exist "client\dist" (
    echo [提示] 正在编译前端界面...
    call npm run build
)

echo.
echo ========================================================
echo [启动] 正在启动 GPT-SoVITS 直播控制台 (Windows)...
echo ========================================================
echo.

echo [检查] 正在检查 Windows 防火墙入站规则...
netsh advfirewall firewall show rule name="GPT-SoVITS Live WebUI" >nul 2>nul
if %errorlevel% neq 0 (
    net session >nul 2>nul
    if %errorlevel% equ 0 (
        netsh advfirewall firewall add rule name="GPT-SoVITS Live WebUI" dir=in action=allow protocol=TCP localport=9870 >nul
        echo [完成] 已自动放行 9870 端口的局域网访问。
    ) else (
        echo [提示] 未找到防火墙入站规则，手机可能无法访问。
        echo        请右键以管理员身份运行本脚本，或手动执行下面这条命令：
        echo        netsh advfirewall firewall add rule name="GPT-SoVITS Live WebUI" dir=in action=allow protocol=TCP localport=9870
    )
)

node server\index.js
pause

@echo off
REM 构建 Rust HUD。前置：rustup + x86_64-pc-windows-gnu 工具链。
REM 关键：dlltool 在工具链 self-contained 目录里，必须进 PATH；
REM       windows-sys 0.61 会走 raw-dylib 并失败，所以 winit/softbuffer 的版本已钉住。
set RUSTUP_HOME=F:\rust\rustup
set CARGO_HOME=F:\rust\cargo
set TMP=F:\rust\tmp
set TEMP=F:\rust\tmp
set PATH=%CARGO_HOME%\bin;%RUSTUP_HOME%\toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained;%PATH%
cargo build --release || exit /b 1
copy /y target\release\magpie-hud-native.exe magpie-hud-native.exe >nul
echo built: desktop-rust\magpie-hud-native.exe
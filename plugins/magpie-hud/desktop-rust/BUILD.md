# 构建说明

## 形态

`desktop-rust/` 是 HUD 的**窗口外壳**：tao 0.37 开一个无边框、置顶、跳任务栏、透明的窗口，
里面塞 wry 0.57 + WebView2 加载插件自己的页面（`webapp/hud.html`）。页面负责所有绘制与交互，
外壳只做四件事：摆位、拖动、把页面报的高度应用到窗口、以及把「打开面板／隐藏」这类动作交给系统。

以前是 winit + softbuffer + fontdue 手绘 canvas，文字天生发虚、审批和配置也做不出来，已整体替换。

## Windows（本机已验证）

```
build.cmd
```

环境已固化在 build.cmd 里：
- `RUSTUP_HOME=F:\rust\rustup`、`CARGO_HOME=F:\rust\cargo`、`TMP/TEMP=F:\rust\tmp`
- PATH 里加工具链的 `lib/rustlib/x86_64-pc-windows-gnu/bin/self-contained`
- 目标 `x86_64-pc-windows-gnu`，**不需要 MSVC**

### GNU 工具链要一个 `as.exe`（这是本机构建唯一的硬依赖）

`windows` 系列 crate 走 `raw-dylib`，rustc 在 GNU 目标上只能自己用 `dlltool` 造 import library，
而 `dlltool` 要调 GNU 汇编器 `as` 来生成 .o。rustup 自带的 `self-contained/` 只有
`dlltool.exe / ld.exe / libwinpthread-1.dll`，**没有 `as.exe`**，于是出现：

```
dlltool could not create import library ... : CreateProcess
```

修法：把 binutils 的 `as.exe` 放进那个 `self-contained/` 目录（dlltool 按 PATH 找 `as`）。
本机是从 MSYS2 的 mingw64 包里取的 2.47：

```
curl -sL -o /f/rust/tmp/binutils.zst https://repo.msys2.org/mingw/mingw64/mingw-w64-x86_64-binutils-2.47-4-any.pkg.tar.zst
# 解 .tar.zst 用 fzstd（插件依赖里就有），再 tar -xf 出 mingw64/bin/as.exe
cp mingw64/bin/as.exe "$(rustc --print sysroot)/lib/rustlib/x86_64-pc-windows-gnu/bin/self-contained/"
```

### 运行时要 WebView2 的两个东西

1. **WebView2 运行时**（Edgeless 的 Edge WebView2 Runtime），Win10/11 一般已装。
   缺了外壳会直接退出并打印 `WebView2 初始化失败：…`，插件那边落 `.failed` 标记。
2. **`WebView2Loader.dll`**：随 exe 一起发布（`desktop-rust/WebView2Loader.dll`，来自
   `webview2-com-sys` 的 x64 目录）。它不在的话进程起不来，报
   `error while loading shared libraries: WebView2Loader.dll`。

WebView2 的用户数据目录指到 `%LOCALAPPDATA%\magpie-hud\webview`（见 main.rs 里的
`WEBVIEW2_USER_DATA_FOLDER`），**不会**在 exe 旁边堆缓存目录。

## macOS / Linux

**必须在对端系统或 CI 上构建**（macOS 的二进制需要 macOS 链接器，Rust 不解决交叉链接）。
macOS 上 wry 用 WKWebView、Linux 用 WebKitGTK：`cargo check` 能过，运行起来还要系统装了
对应 WebView（Linux 需要 `webkit2gtk-4.1`）。

```
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cargo check --release --target aarch64-apple-darwin
cargo check --release --target x86_64-apple-darwin
cargo check --release --target x86_64-unknown-linux-gnu
```

出产物走 `.github/workflows/hud-native.yml`（推 `hud-v*` tag 触发）。

## 产物放哪

构建完把二进制放到 `desktop-rust/magpie-hud-native[.exe]`——插件按这个路径发现它
（优先级：`desktop-rust` → `desktop-native`）。Windows 上还要把 `WebView2Loader.dll`
放在同一个目录。macOS/Linux 用无扩展名的同名文件。

## 单测

```
cargo test --release
```

22 条：摆位（刘海/顶部/自定义/125%、150% 缩放/跨屏收回）+ IPC 解析（拖动、高度 clamp、
open 只放行本机端口、按会话 id 打开、未知指令、非 JSON）。

//go:build !windows

// 非 Windows 平台的占位实现。
//
// Windows 版用 user32/gdi32 直接绘制（零浏览器依赖）。macOS 需要 AppKit、Linux 需要
// X11/Wayland，各自一套原生代码；在它们实现之前，这里以 0 退出并打印原因——
// 插件端看到进程立刻退出就跳过 HUD，页面功能完全不受影响。
//
// 参照 agent-hud-open：Rust + Tauri，macOS 走 objc2/AppKit，并 fork 了 tao 才能创建
// nonactivating NSPanel（其 docs/tao-panel-patch.md）。macOS 的 Go 对等物是
// NSWindow + NSView.drawRect（CoreGraphics）+ NSStatusItem，需要 cgo（只能在 Mac 上构建）。
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "magpie-hud-native: only the Windows backend is implemented; macOS needs an AppKit backend")
	os.Exit(0)
}
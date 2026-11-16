//go:build windows

// 鹊楼原生 HUD（magpie-hud-native）：纯 Go + Win32 GDI 绘制，不依赖任何浏览器引擎。
//
// 为什么换成它：原来的 wails/WebView2 版本在旧运行时上会 CreateCoreWebView2Controller
// 失败（0x8000FFFF），而「用户装插件不允许出现这种依赖问题」是硬要求。HUD 要画的只有
// 几个环、几行字——GDI 足够，而且：零依赖、零 cgo、单文件 2MB 级、任何 Windows 都能跑。
//
// 能力（全部靠 Win32，不需要页面、不需要 wails 运行时）：
//   - 分层窗口（UpdateLayeredWindow）：逐像素 alpha → 真透明 + 圆角、无白边
//   - WM_NCHITTEST 返回 HTCAPTION：顶部条原生拖动（不需要 --wails-draggable）
//   - 右键菜单 + 托盘图标（Shell_NotifyIcon）+ Esc 隐藏
//   - 数据来自插件服务（HTTP），每 8 秒刷新；不改任何宿主状态
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	pRegisterClassExW  = user32.NewProc("RegisterClassExW")
	pCreateWindowExW   = user32.NewProc("CreateWindowExW")
	pDefWindowProcW    = user32.NewProc("DefWindowProcW")
	pDestroyWindow     = user32.NewProc("DestroyWindow")
	pShowWindow        = user32.NewProc("ShowWindow")
	pUpdateWindow      = user32.NewProc("UpdateWindow")
	pGetMessageW       = user32.NewProc("GetMessageW")
	pTranslateMessage  = user32.NewProc("TranslateMessage")
	pDispatchMessageW  = user32.NewProc("DispatchMessageW")
	pPostQuitMessage   = user32.NewProc("PostQuitMessage")
	pSetTimer          = user32.NewProc("SetTimer")
	pLoadCursorW       = user32.NewProc("LoadCursorW")
	pGetSystemMetrics  = user32.NewProc("GetSystemMetrics")
	pGetCursorPos      = user32.NewProc("GetCursorPos")
	pCreatePopupMenu   = user32.NewProc("CreatePopupMenu")
	pAppendMenuW       = user32.NewProc("AppendMenuW")
	pTrackPopupMenu    = user32.NewProc("TrackPopupMenu")
	pDestroyMenu       = user32.NewProc("DestroyMenu")
	pSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	pPostMessageW      = user32.NewProc("PostMessageW")
	pUpdateLayeredWindow = user32.NewProc("UpdateLayeredWindow")
	pShowWindowAsync   = user32.NewProc("ShowWindowAsync")
	pIsWindowVisible   = user32.NewProc("IsWindowVisible")
	pMonitorFromRect   = user32.NewProc("MonitorFromRect")
	pGetMonitorInfoW   = user32.NewProc("GetMonitorInfoW")
	pShellNotifyIcon   = shell32.NewProc("Shell_NotifyIconW")
	pShellExecuteW     = shell32.NewProc("ShellExecuteW")
	pCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	pCreateDIBSection  = gdi32.NewProc("CreateDIBSection")
	pSelectObject      = gdi32.NewProc("SelectObject")
	pDeleteObject      = gdi32.NewProc("DeleteObject")
	pDeleteDC          = gdi32.NewProc("DeleteDC")
	pCreateSolidBrush  = gdi32.NewProc("CreateSolidBrush")
	pCreatePen         = gdi32.NewProc("CreatePen")
	pCreateFontW       = gdi32.NewProc("CreateFontW")
	pSetTextColor      = gdi32.NewProc("SetTextColor")
	pSetBkMode         = gdi32.NewProc("SetBkMode")
	pDrawTextW         = user32.NewProc("DrawTextW")
	pRoundRect         = gdi32.NewProc("RoundRect")
	pEllipse           = gdi32.NewProc("Ellipse")
	pArc               = gdi32.NewProc("Arc")
	pPatBlt            = gdi32.NewProc("PatBlt")
)

const (
	wsPopup      = 0x80000000
	wsVisible    = 0x10000000
	wsExLayered  = 0x00080000
	wsExTopmost  = 0x00000008
	wsExToolwin  = 0x00000080
	wsExNoActivate = 0x08000000
	csHRedraw    = 0x0002
	csVRedraw    = 0x0001
	wmDestroy    = 0x0002
	wmClose      = 0x0010
	wmPaint      = 0x000F
	wmKeyDown    = 0x0100
	wmRButtonUp  = 0x0205
	wmLButtonDblClk = 0x0203
	wmNCHitTest  = 0x0084
	wmApp        = 0x8000
	wmTimer      = 0x0113
	pmRightAlign = 0x0008
	tpmLeftAlign = 0x0000
	tpmReturnCmd = 0x0100
	htCaption    = 2
	htClient     = 1
	ulwAlpha     = 0x00000002
	acSrcOver    = 0x00
	acSrcAlpha   = 0x01
	swHide       = 0
	swShownormal = 1
	nimAdd       = 0x00000000
	nimModify    = 0x00000001
	nimDelete    = 0x00000002
	nifMessage   = 0x00000001
	nifIcon      = 0x00000002
	nifTip       = 0x00000004
	transparent  = 1
	psSolid      = 0
	fwNormal     = 400
	fwBold       = 700
	dtLeft       = 0x00000000
	dtCenter     = 0x00000001
	dtVCenter    = 0x00000004
	dtSingleLine = 0x00000020
	dtEndEllipsis = 0x00008000
)

type WNDCLASSEXW struct {
	CbSize        uint32
	Style         uint32
	LpfnWndProc   uintptr
	CbClsExtra    int32
	CbWndExtra    int32
	HInstance     syscall.Handle
	HIcon         syscall.Handle
	HCursor       syscall.Handle
	HbrBackground syscall.Handle
	LpszMenuName  *uint16
	LpszClassName *uint16
	HIconSm       syscall.Handle
}

type MSG struct {
	Hwnd    syscall.Handle
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
}

type POINT struct{ X, Y int32 }

type RECT struct{ Left, Top, Right, Bottom int32 }

type SIZE struct{ Cx, Cy int32 }

type BLENDFUNCTION struct {
	BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat byte
}

type BITMAPINFOHEADER struct {
	BiSize          uint32
	BiWidth         int32
	BiHeight        int32
	BiPlanes        uint16
	BiBitCount      uint16
	BiCompression   uint32
	BiSizeImage     uint32
	BiXPelsPerMeter int32
	BiYPelsPerMeter int32
	BiClrUsed       uint32
	BiClrImportant  uint32
}

type BITMAPINFO struct {
	BmiHeader BITMAPINFOHEADER
	BmiColors [1]uint32
}

type NOTIFYICONDATAW struct {
	CbSize           uint32
	HWnd             syscall.Handle
	UID              uint32
	UFlags           uint32
	UCallbackMessage uint32
	HIcon            syscall.Handle
	SzTip            [128]uint16
	DwState          uint32
	DwStateMask      uint32
	SzInfo           [256]uint16
	UVersion         uint32
	SzInfoTitle      [64]uint16
	DwInfoFlags      uint32
}

type MONITORINFO struct {
	CbSize    uint32
	RcMonitor RECT
	RcWork    RECT
	DwFlags   uint32
}

// ── 数据 ───────────────────────────────────────

type quotaAccount struct {
	Provider string `json:"provider"`
	Name     string `json:"name"`
	User     string `json:"user"`
	Windows  []struct {
		Name    string   `json:"name"`
		Percent *float64 `json:"percent"`
		Left    *float64 `json:"left"`
	} `json:"windows"`
}

type snapshot struct {
	Sessions int
	Running  int
	Waiting  int
	Cost     float64
	HasCost  bool
	Tight    int
	Warn     int
	Loose    int
	Rings    []ring
}

type ring struct {
	Label   string
	Percent float64
}

var (
	mu   sync.Mutex
	snap = snapshot{}
	svc  string
	selfHWND syscall.Handle
)

func fetchJSON(path string, out any) error {
	client := http.Client{Timeout: 8 * time.Second}
	res, err := client.Get(svc + path)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("%s: %d", path, res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func refresh() {
	var st struct {
		Sessions []struct {
			State   string `json:"state"`
			Pending *struct{ Kind string `json:"kind"` } `json:"pending"`
		} `json:"sessions"`
	}
	var q struct {
		Providers []quotaAccount `json:"providers"`
	}
	var tk struct {
		Cost *struct {
			USD float64 `json:"usd"`
		} `json:"cost"`
	}
	var next snapshot
	if err := fetchJSON("/api/state", &st); err != nil {
		log.Printf("state: %v", err)
		return
	}
	next.Sessions = len(st.Sessions)
	for _, s := range st.Sessions {
		if s.State == "running" {
			next.Running++
		}
		if s.Pending != nil {
			next.Waiting++
		}
	}
	if err := fetchJSON("/api/quotas", &q); err == nil {
		// 每个 provider 取最紧的窗口画环，按百分比降序取前 3
		seen := map[string]float64{}
		for _, a := range q.Providers {
			for _, w := range a.Windows {
				if w.Percent == nil {
					continue
				}
				p := *w.Percent
				if p >= 90 {
					next.Tight++
				} else if p >= 70 {
					next.Warn++
				} else {
					next.Loose++
				}
				if cur, ok := seen[a.Provider]; !ok || p > cur {
					seen[a.Provider] = p
				}
			}
		}
		type kv struct {
			k string
			v float64
		}
		var list []kv
		for k, v := range seen {
			list = append(list, kv{k, v})
		}
		for i := 0; i < len(list); i++ {
			for j := i + 1; j < len(list); j++ {
				if list[j].v > list[i].v {
					list[i], list[j] = list[j], list[i]
				}
			}
		}
		for i := 0; i < len(list) && i < 3; i++ {
			next.Rings = append(next.Rings, ring{Label: list[i].k, Percent: list[i].v})
		}
	}
	if err := fetchJSON("/api/tokens?period=24h", &tk); err == nil && tk.Cost != nil {
		next.Cost = tk.Cost.USD
		next.HasCost = true
	}
	mu.Lock()
	snap = next
	mu.Unlock()
}

func main() {
	runtime.LockOSThread()
	port := flag.Int("port", 3477, "the plugin service port")
	flag.Parse()
	svc = fmt.Sprintf("http://127.0.0.1:%d", *port)

	go func() {
		for {
			refresh()
			if selfHWND != 0 {
				pPostMessageW.Call(uintptr(selfHWND), wmApp, 0, 0)
			}
			time.Sleep(8 * time.Second)
		}
	}()

	hInst, _, _ := kernel32.NewProc("GetModuleHandleW").Call(0)
	className, _ := syscall.UTF16PtrFromString("MagpieHudNative")
	winTitle, _ := syscall.UTF16PtrFromString("鹊楼")

	wc := WNDCLASSEXW{
		CbSize:        uint32(unsafe.Sizeof(WNDCLASSEXW{})),
		Style:         csHRedraw | csVRedraw,
		LpfnWndProc:   syscall.NewCallback(wndProc),
		HInstance:     syscall.Handle(hInst),
		LpszClassName: className,
	}
	cur, _, _ := pLoadCursorW.Call(0, 32512) // IDC_ARROW
	wc.HCursor = syscall.Handle(cur)
	if r, _, err := pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		log.Fatalf("RegisterClassExW: %v", err)
	}

	hwnd, _, err := pCreateWindowExW.Call(
		wsExLayered|wsExTopmost|wsExToolwin,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(winTitle)),
		wsPopup|wsVisible,
		100, 100, 560, 160,
		0, 0, hInst, 0)
	if hwnd == 0 {
		log.Fatalf("CreateWindowExW: %v", err)
	}
	selfHWND = syscall.Handle(hwnd)

	placeAndPaint()
	pShowWindow.Call(hwnd, swShownormal)
	addTray()
	pSetTimer.Call(hwnd, 1, 2000, 0)

	var msg MSG
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}

	pShellNotifyIcon.Call(nimDelete, uintptr(unsafe.Pointer(trayData())))
}

// ── 窗口过程 ────────────────────────────────────

func wndProc(hwnd syscall.Handle, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case wmNCHitTest:
		// 顶部 34px 当标题栏：Windows 自己处理拖动，无需任何前端运行时
		y := int32(lParam>>16) & 0xFFFF
		var pt POINT
		pGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
		_ = y
		// 用屏幕坐标与窗口位置比较更可靠
		var wr RECT
		getWindowRect(hwnd, &wr)
		if pt.Y >= wr.Top && pt.Y < wr.Top+34 {
			return htCaption
		}
		return htClient
	case wmPaint:
		paint()
		return 0
	case wmTimer:
		placeAndPaint()
		return 0
	case wmApp:
		paint()
		return 0
	case wmKeyDown:
		if wParam == 0x1B { // Esc
			pShowWindow.Call(uintptr(hwnd), swHide)
		}
		return 0
	case wmLButtonDblClk:
		openFullPanel()
		return 0
	case wmRButtonUp:
		showMenu(hwnd)
		return 0
	case wmClose:
		pDestroyWindow.Call(uintptr(hwnd))
		return 0
	case wmDestroy:
		pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wParam, lParam)
	return r
}

func getWindowRect(h syscall.Handle, r *RECT) {
	proc := user32.NewProc("GetWindowRect")
	proc.Call(uintptr(h), uintptr(unsafe.Pointer(r)))
}

func showMenu(hwnd syscall.Handle) {
	menu, _, _ := pCreatePopupMenu.Call()
	addMenu := func(id uintptr, text string) {
		t, _ := syscall.UTF16PtrFromString(text)
		pAppendMenuW.Call(menu, 0, id, uintptr(unsafe.Pointer(t)))
	}
	addMenu(1, "打开完整面板")
	addMenu(2, "隐藏（Esc）")
	addMenu(3, "刷新")
	addMenu(4, "退出")
	var pt POINT
	pGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	pSetForegroundWindow.Call(uintptr(hwnd))
	id, _, _ := pTrackPopupMenu.Call(menu, tpmLeftAlign|tpmReturnCmd, uintptr(pt.X), uintptr(pt.Y), 0, uintptr(hwnd), 0)
	pDestroyMenu.Call(menu)
	switch id {
	case 1:
		openFullPanel()
	case 2:
		pShowWindow.Call(uintptr(hwnd), swHide)
	case 3:
		go func() { refresh(); pPostMessageW.Call(uintptr(hwnd), wmApp, 0, 0) }()
	case 4:
		pDestroyWindow.Call(uintptr(hwnd))
	}
}

func openFullPanel() {
	url, _ := syscall.UTF16PtrFromString(svc + "/")
	op, _ := syscall.UTF16PtrFromString("open")
	pShellExecuteW.Call(0, uintptr(unsafe.Pointer(op)), uintptr(unsafe.Pointer(url)), 0, 0, 1)
}

func trayData() *NOTIFYICONDATAW {
	d := &NOTIFYICONDATAW{
		CbSize:           uint32(unsafe.Sizeof(NOTIFYICONDATAW{})),
		HWnd:             selfHWND,
		UID:              1,
		UFlags:           nifMessage | nifTip | nifIcon,
		UCallbackMessage: wmApp + 1,
	}
	icon, _, _ := user32.NewProc("LoadIconW").Call(0, 32512) // IDI_APPLICATION
	d.HIcon = syscall.Handle(icon)
	tip := syscall.StringToUTF16("鹊楼 · agent HUD")
	copy(d.SzTip[:], tip)
	return d
}

func addTray() {
	pShellNotifyIcon.Call(nimAdd, uintptr(unsafe.Pointer(trayData())))
}

// ── 设置与摆放 ──────────────────────────────────

type settings struct {
	Position  string `json:"position"`
	Notch     bool   `json:"notch"`
	AutoShape bool   `json:"autoShape"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Opacity   float64 `json:"opacity"`
	X         int     `json:"x"`
	Y         int     `json:"y"`
}

func fetchSettings() settings {
	s := settings{Position: "top-center", AutoShape: true, Width: 560, Height: 160, Opacity: 0.94}
	_ = fetchJSON("/api/settings", &s)
	return s
}

func effectiveSize(s settings) (int, int) {
	if !s.AutoShape && s.Width > 0 && s.Height > 0 {
		return s.Width, s.Height
	}
	if s.Notch {
		return 560, 140
	}
	if len(s.Position) >= 3 && s.Position[:3] == "top" {
		return 560, 160
	}
	if s.Position == "left" || s.Position == "right" {
		return 240, 520
	}
	return 560, 160
}

func workArea() RECT {
	var r RECT
	proc := user32.NewProc("SystemParametersInfoW")
	// SPI_GETWORKAREA = 0x0030
	proc.Call(0x0030, 0, uintptr(unsafe.Pointer(&r)), 0)
	if r.Right == 0 {
		sw, _, _ := pGetSystemMetrics.Call(0)
		sh, _, _ := pGetSystemMetrics.Call(1)
		r = RECT{0, 0, int32(sw), int32(sh)}
	}
	return r
}

func placeAndPaint() {
	s := fetchSettings()
	w, h := effectiveSize(s)
	wa := workArea()
	const gap = 10
	x, y := int32(wa.Left+gap), int32(wa.Top+gap)
	switch {
	case s.Position == "custom":
		x, y = int32(s.X), int32(s.Y)
	case s.Position == "top-left":
		x = wa.Left + gap
	case s.Position == "top-right":
		x = wa.Right - int32(w) - gap
	case s.Position == "left":
		x = wa.Left + gap
		y = wa.Top + (wa.Bottom-wa.Top-int32(h))/2
	case s.Position == "right":
		x = wa.Right - int32(w) - gap
		y = wa.Top + (wa.Bottom-wa.Top-int32(h))/2
	default: // top-center
		x = wa.Left + (wa.Right-wa.Left-int32(w))/2
	}
	if s.Notch {
		y = 0
	}
	setWindowPos := user32.NewProc("SetWindowPos")
	// SWP_NOZORDER(4) | SWP_NOACTIVATE(0x10)
	setWindowPos.Call(uintptr(selfHWND), 0, uintptr(x), uintptr(y), uintptr(w), uintptr(h), 4|0x10)
	paint()
}

// ── 绘制（GDI → 32bpp DIB → 逐像素 alpha → UpdateLayeredWindow）──

var sentinel uint32 = 0x00FF00FF // 洋红：画完后当作「全透明」

func rgb(r, g, b byte) uint32 { return uint32(r) | uint32(g)<<8 | uint32(b)<<16 }

var (
	colBG      = rgb(0x28, 0x28, 0x28)
	colFG      = rgb(0xF5, 0xF5, 0xF7)
	colMuted   = rgb(0x98, 0x98, 0x9D)
	colTrack   = rgb(0x3A, 0x3A, 0x3C)
	colOK      = rgb(0x32, 0xD5, 0x83)
	colWarn    = rgb(0xFF, 0x9F, 0x0A)
	colBad     = rgb(0xFF, 0x45, 0x3A)
)

func levelColor(p float64) uint32 {
	if p >= 90 {
		return colBad
	}
	if p >= 70 {
		return colWarn
	}
	return colOK
}

func paint() {
	if selfHWND == 0 {
		return
	}
	var wr RECT
	getWindowRect(selfHWND, &wr)
	w := int(wr.Right - wr.Left)
	h := int(wr.Bottom - wr.Top)
	if w <= 0 || h <= 0 {
		return
	}

	hdcScreen, _, _ := user32.NewProc("GetDC").Call(0)
	memDC, _, _ := pCreateCompatibleDC.Call(hdcScreen)
	bi := BITMAPINFO{}
	bi.BmiHeader.BiSize = uint32(unsafe.Sizeof(BITMAPINFOHEADER{}))
	bi.BmiHeader.BiWidth = int32(w)
	bi.BmiHeader.BiHeight = -int32(h) // top-down
	bi.BmiHeader.BiPlanes = 1
	bi.BmiHeader.BiBitCount = 32
	var bits unsafe.Pointer
	hbmp, _, _ := pCreateDIBSection.Call(memDC, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if hbmp == 0 || bits == nil {
		return
	}
	old, _, _ := pSelectObject.Call(memDC, hbmp)

	px := unsafe.Slice((*uint32)(bits), w*h)
	for i := range px {
		px[i] = sentinel
	}

	// 面板底
	brush, _, _ := pCreateSolidBrush.Call(uintptr(colBG))
	pen, _, _ := pCreatePen.Call(psSolid, 1, uintptr(colBG))
	oldBrush, _, _ := pSelectObject.Call(memDC, brush)
	oldPen, _, _ := pSelectObject.Call(memDC, pen)
	pRoundRect.Call(memDC, 0, 0, uintptr(w), uintptr(h), 28, 28)

	// 文字准备
	pSetBkMode.Call(memDC, transparent)
	// 负高度＝字符高度（GDI 约定）；常量负数不能直接转 uintptr，先落到变量
	hReg, hBold := -15, -17
	fontName := "Microsoft YaHei UI"
	fontReg, _, _ := pCreateFontW.Call(uintptr(hReg), 0, 0, 0, fwNormal, 0, 0, 0, 1, 0, 0, 0, 0, uintptr(unsafe.Pointer(mustPtr(fontName))))
	fontBold, _, _ := pCreateFontW.Call(uintptr(hBold), 0, 0, 0, fwBold, 0, 0, 0, 1, 0, 0, 0, 0, uintptr(unsafe.Pointer(mustPtr(fontName))))

	drawText := func(font syscall.Handle, text string, x, y, ww, hh int, color uint32, center bool) {
		pSelectObject.Call(memDC, uintptr(font))
		pSetTextColor.Call(memDC, uintptr(color))
		t := syscall.StringToUTF16(text)
		r := RECT{int32(x), int32(y), int32(x + ww), int32(y + hh)}
		flags := uintptr(dtSingleLine | dtVCenter)
		if center {
			flags |= dtCenter
		} else {
			flags |= dtLeft
		}
		pDrawTextW.Call(memDC, uintptr(unsafe.Pointer(&t[0])), uintptr(len(t)-1), uintptr(unsafe.Pointer(&r)), flags)
	}

	mu.Lock()
	s := snap
	mu.Unlock()

	// 标题
	drawText(syscall.Handle(fontBold), "鹊楼", 16, 8, 120, 26, colFG, false)
	busy := fmt.Sprintf("%d 在跑", s.Running)
	if s.Waiting > 0 {
		busy = fmt.Sprintf("%d 等你", s.Waiting)
	}
	drawText(syscall.Handle(fontReg), busy, w-200, 8, 120, 26, colMuted, true)
	if s.HasCost {
		drawText(syscall.Handle(fontBold), fmt.Sprintf("$%.2f", s.Cost), w-84, 8, 74, 26, colFG, true)
	}

	// 额度环（最多 3 个，横排）
	ringY := 46
	for i, r := range s.Rings {
		cx := 40 + i*92
		cy := ringY + 30
		radius := 22.0
		// 轨道
		trackPen, _, _ := pCreatePen.Call(psSolid, 5, uintptr(colTrack))
		pSelectObject.Call(memDC, trackPen)
		tb, _, _ := pCreateSolidBrush.Call(uintptr(0x01FFFFFF)) // NULL_BRUSH 近似：不填充
		_ = tb
		pEllipse.Call(memDC, uintptr(float64(cx)-radius), uintptr(float64(cy)-radius), uintptr(float64(cx)+radius), uintptr(float64(cy)+radius))
		// 进度弧
		col := levelColor(r.Percent)
		arcPen, _, _ := pCreatePen.Call(psSolid, 5, uintptr(col))
		pSelectObject.Call(memDC, arcPen)
		endDeg := -90 + 360*r.Percent/100
		ex := float64(cx) + radius*math.Cos(endDeg*math.Pi/180)
		ey := float64(cy) + radius*math.Sin(endDeg*math.Pi/180)
		pArc.Call(memDC, uintptr(float64(cx)-radius), uintptr(float64(cy)-radius), uintptr(float64(cx)+radius), uintptr(float64(cy)+radius), uintptr(cx), uintptr(float64(cy)-radius), uintptr(ex), uintptr(ey))
		// 百分比
		drawText(syscall.Handle(fontBold), fmt.Sprintf("%.0f%%", r.Percent), cx-30, cy-13, 60, 26, colFG, true)
		// provider 名
		drawText(syscall.Handle(fontReg), shortLabel(r.Label), cx-46, cy+24, 92, 20, colMuted, true)
	}

	// 底部一行
	line := fmt.Sprintf("%d 个会话 · %d 个在跑", s.Sessions, s.Running)
	if s.Waiting > 0 {
		line += fmt.Sprintf(" · %d 等你", s.Waiting)
	}
	if s.Tight+s.Warn+s.Loose > 0 {
		line += fmt.Sprintf(" · 额度 %d紧/%d中/%d松", s.Tight, s.Warn, s.Loose)
	}
	drawText(syscall.Handle(fontReg), line, 16, h-30, w-32, 22, colMuted, false)

	// ── alpha 处理：洋红→透明；四角按圆角裁掉 ──
	opacity := 1.0
	{
		cfg := fetchSettings()
		if cfg.Opacity >= 0.4 && cfg.Opacity <= 1 {
			opacity = cfg.Opacity
		}
	}
	a := uint8(255 * opacity)
	const radius = 14
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			i := y*w + x
			if px[i] == sentinel {
				px[i] = 0
				continue
			}
			// 圆角遮罩
			dx, dy := 0, 0
			if x < radius && y < radius {
				dx, dy = radius-x, radius-y
			} else if x >= w-radius && y < radius {
				dx, dy = x-(w-radius-1), radius-y
			} else if x < radius && y >= h-radius {
				dx, dy = radius-x, y-(h-radius-1)
			} else if x >= w-radius && y >= h-radius {
				dx, dy = x-(w-radius-1), y-(h-radius-1)
			}
			if dx*dx+dy*dy > radius*radius {
				px[i] = 0
				continue
			}
			px[i] = (px[i] & 0x00FFFFFF) | uint32(a)<<24
		}
	}

	// 提交分层窗口
	var dst POINT
	dst.X, dst.Y = wr.Left, wr.Top
	sz := SIZE{int32(w), int32(h)}
	var src POINT
	bf := BLENDFUNCTION{BlendOp: acSrcOver, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: acSrcAlpha}
	pUpdateLayeredWindow.Call(uintptr(selfHWND), hdcScreen, uintptr(unsafe.Pointer(&dst)), uintptr(unsafe.Pointer(&sz)), memDC, uintptr(unsafe.Pointer(&src)), 0, uintptr(unsafe.Pointer(&bf)), ulwAlpha)

	// 清理
	pSelectObject.Call(memDC, old)
	pSelectObject.Call(memDC, oldBrush)
	pSelectObject.Call(memDC, oldPen)
	pDeleteObject.Call(hbmp)
	pDeleteObject.Call(brush)
	pDeleteObject.Call(pen)
	pDeleteObject.Call(fontReg)
	pDeleteObject.Call(fontBold)
	pDeleteDC.Call(memDC)
	releaseDC, _, _ := user32.NewProc("ReleaseDC").Call(0, hdcScreen)
	_ = releaseDC
}

func mustPtr(s string) *uint16 {
	p, err := syscall.UTF16PtrFromString(s)
	if err != nil {
		p, _ = syscall.UTF16PtrFromString("Segoe UI")
	}
	return p
}

func shortLabel(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}

var _ = os.Getenv

// 鹊楼 HUD 桌面桥（magpie-hud-desktop）。
//
// 职责只有两件宿主给不了的事：把窗口放到桌面上、记住并跟随用户摆的位置。
// 数据、渲染、设置界面全在插件里（页面经 /api/* 取）。
//
// 语言选 Go：magpie 本身就是 Go + wails v3，Windows 上 wails 走 COM，
// CGO_ENABLED=0、无 gcc/cl 也能构建（实测），产物 10MB 单文件、无运行时。
//
// 关键实现决定（都是踩过坑换来的）：
//  1. WebView2CompositionHosting 必须开。wails 的无边框拖拽（CSS
//     --wails-draggable: drag）被 window._wails.flags.nonClientRegionTracking
//     门控，而这个 flag 只在该选项为 true 时才是 true；默认 false 时拖不动。
//  2. 位置跟踪必须「以目标为准」。SetPosition 在 Windows 上是异步的，
//     调用后立刻 Position() 读到的是旧值；若把旧值当成「用户拖动」存成
//     custom，就会自激：存旧位置 → 应用 → 又读旧值 → 再存……窗口于是自己
//     跳来跳去。所以这里记住 targetX/targetY（我们要求的位置），并有
//     冷却期与位移阈值，只把「稳定且明显偏离目标」的位置当成用户拖动。
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"image"
	"image/color"
	"image/png"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

var version = "dev"

const (
	// 应用位置后的冷却：这段时间内不把位置差异当成用户拖动
	settleFor = 4 * time.Second
	// 偏离目标这么多像素才算「被拖动」
	dragSlop = 10
	// 连续这么多拍位置稳定才落盘（1 拍 = 1.2s）
	dragTicks = 3
)

type Settings struct {
	Position    string  `json:"position"`
	Screen      string  `json:"screen"`
	AutoShape   bool    `json:"autoShape"`
	X           int     `json:"x"`
	Y           int     `json:"y"`
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	Opacity     float64 `json:"opacity"`
	Notch       bool    `json:"notch"`
	AlwaysOnTop bool    `json:"alwaysOnTop"`
}

func defaults() Settings {
	return Settings{Position: "top-center", Width: 320, Height: 420, Opacity: 0.94, AlwaysOnTop: true}
}

func fetchSettings(url string) Settings {
	s := defaults()
	client := http.Client{Timeout: 3 * time.Second}
	res, err := client.Get(url)
	if err != nil {
		return s
	}
	defer res.Body.Close()
	if err := json.NewDecoder(res.Body).Decode(&s); err != nil {
		return defaults()
	}
	if s.Width <= 0 {
		s.Width = 320
	}
	if s.Height <= 0 {
		s.Height = 420
	}
	if s.Position == "" {
		s.Position = "top-center"
	}
	return s
}

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }

func postJSON(url string, patch map[string]any) error {
	body, err := json.Marshal(patch)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 3 * time.Second}
	req, err := http.NewRequest(http.MethodPost, url, bytesReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}

// pickScreen 按设置里的显示器 ID 选屏；空或找不到就用主屏。
func pickScreen(app *application.App, id string) *application.Screen {
	if id != "" {
		if s := app.Screen.GetByID(id); s != nil {
			return s
		}
	}
	if p := app.Screen.GetPrimary(); p != nil {
		return p
	}
	all := app.Screen.GetAll()
	if len(all) > 0 {
		return all[0]
	}
	return nil
}

func screensOf(app *application.App) []map[string]any {
	primary := app.Screen.GetPrimary()
	out := []map[string]any{}
	for _, s := range app.Screen.GetAll() {
		out = append(out, map[string]any{
			"id": s.ID, "name": s.Name, "width": s.Size.Width, "height": s.Size.Height,
			"primary": primary != nil && s.ID == primary.ID,
		})
	}
	return out
}

// effectiveSize 按吸附边决定尺寸：贴在屏幕顶边时宽而扁，贴在左右时窄而高。
// 用户的原话是「宽度长一点」「对应侧边栏就是高度高一些、宽度窄一些」，
// 所以形状跟着吸附边变，而不是固定一个长宽比。
func effectiveSize(s Settings) (int, int) {
	if !s.AutoShape {
		return s.Width, s.Height
	}
	switch {
	case s.Notch:
		return 560, 140 // 刘海条：更矮
	case strings.HasPrefix(s.Position, "top"):
		return 560, 160 // 顶部：宽扁（比初版矮 20%）
	case s.Position == "left" || s.Position == "right":
		return 240, 520 // 侧边：窄高（比初版窄 20%）
	default:
		return s.Width, s.Height // custom 等：用用户自己定的
	}
}

// place 把设置算成屏幕坐标。工作区（去掉任务栏）优先；刘海模式贴屏幕真实顶部。
func place(s Settings, scr *application.Screen) (int, int) {
	w, h := effectiveSize(s)
	if scr == nil {
		return s.X, s.Y
	}
	if s.Position == "custom" {
		return s.X, s.Y
	}
	work := scr.WorkArea
	if work.Width == 0 || work.Height == 0 {
		work = application.Rect{X: scr.X, Y: scr.Y, Width: scr.Size.Width, Height: scr.Size.Height}
	}
	const gap = 10
	top := work.Y + gap
	if s.Notch {
		top = scr.Y // 刘海屏：贴物理顶部
	}
	switch s.Position {
	case "top-left":
		return work.X + gap, top
	case "top-right":
		return work.X + work.Width - w - gap, top
	case "left":
		return work.X + gap, work.Y + (work.Height-h)/2
	case "right":
		return work.X + work.Width - w - gap, work.Y + (work.Height-h)/2
	default: // top-center
		return work.X + (work.Width-w)/2, top
	}
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func main() {
	settingsURL := flag.String("settings-url", "http://127.0.0.1:3477/api/settings", "where the plugin's settings live")
	assets := flag.String("assets", "", "the plugin's webapp folder, served by wails so its runtime is injected")
	flag.Parse()

	base := strings.TrimSuffix(*settingsURL, "/api/settings")

	// 页面由 wails 自己的资源服务器提供。原因：wails 的运行时（window._wails）
	// 只会注入到它自己服务的文档里——外部 URL 实测注入不生效（探针回报
	// hasWebview=true / hasWails=false），而无边框拖拽正是靠运行时的
	// --wails-draggable / 非客户区回调实现的。所以页面必须由 wails 服务，
	// 再跨源访问插件服务（服务端显式放行 http://wails.localhost）。
	assetsDir := *assets
	if assetsDir == "" {
		if exe, err := os.Executable(); err == nil {
			assetsDir = filepath.Join(filepath.Dir(exe), "..", "webapp")
		}
	}
	url := "/app.html?hud=1&base=" + base

	fileServer := http.FileServer(http.Dir(assetsDir))

	cfg := fetchSettings(*settingsURL)
	displayURL := strings.TrimSuffix(*settingsURL, "/settings") + "/display"

	app := application.New(application.Options{
		Name:        "magpie-hud",
		Description: "鹊楼 · desktop HUD for your agents",
		Assets: application.AssetOptions{
			Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// 根路径给 app.html（webapp 里没有 index.html）
				if r.URL.Path == "/" || r.URL.Path == "/index.html" {
					r.URL.Path = "/app.html"
				}
				fileServer.ServeHTTP(w, r)
			}),
		},
	})

	w := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:           "hud",
		Title:          "鹊楼",
		URL:            url,
		Width:          cfg.Width,
		Height:         cfg.Height,
		Frameless:      true,
		AlwaysOnTop:    cfg.AlwaysOnTop,
		DisableResize:  false,
		BackgroundType: application.BackgroundTypeTranslucent,
		// 注意：这里不要再设 BackgroundColour(0,0,0,0)。实测它和
		// WebView2CompositionHosting 一起用会让 composition controller 创建失败
		// （8000FFFF Catastrophic failure），桥直接起不来。窗口的透明由
		// BackgroundTypeTranslucent + 页面 html/body 透明实现，白边已在 CSS 侧解决。
		Mac: application.MacWindow{
			Backdrop:           application.MacBackdropTranslucent,
			CornerRadius:       14,
			CollectionBehavior: application.MacWindowCollectionBehaviorCanJoinAllSpaces | application.MacWindowCollectionBehaviorFullScreenAuxiliary,
			WindowClass:        application.MacWindowClassPanel,
		},
		Windows: application.WindowsWindow{
			HiddenOnTaskbar: true,
			// 必须开：无边框拖拽（--wails-draggable）由它门控。
			WebView2CompositionHosting: true,
		},
	})

	// target 是我们「要求」窗口待的位置，不是读回来的位置。
	targetX, targetY := cfg.X, cfg.Y
	var settleUntil time.Time

	apply := func(s Settings) {
		x, y := place(s, pickScreen(app, s.Screen))
		ew, eh := effectiveSize(s)
		w.SetSize(ew, eh)
		w.SetPosition(x, y)
		w.SetAlwaysOnTop(s.AlwaysOnTop)
		targetX, targetY = x, y
		settleUntil = time.Now().Add(settleFor)
	}

	go func() {
		time.Sleep(700 * time.Millisecond) // 等 webview 建好
		apply(cfg)
		postJSON(displayURL, map[string]any{"screens": screensOf(app), "current": cfg.Screen})

		lastCfg := cfg
		var pending [2]int
		moved := 0

		tick := time.NewTicker(1200 * time.Millisecond)
		defer tick.Stop()
		for range tick.C {
			now := fetchSettings(*settingsURL)

			// ① 设置在插件页面里被改了（位置/尺寸/屏/刘海/置顶）：重新贴
			if now.Position != lastCfg.Position || now.Width != lastCfg.Width || now.Height != lastCfg.Height ||
				now.Notch != lastCfg.Notch || now.AlwaysOnTop != lastCfg.AlwaysOnTop || now.Screen != lastCfg.Screen {
				lastCfg = now
				apply(now)
				moved = 0
				continue
			}

			// ② 用户拖动：冷却期外、明显偏离目标、且连续稳定 —— 才落盘成 custom
			if time.Now().Before(settleUntil) {
				continue
			}
			x, y := w.Position()
			if abs(x-targetX) <= dragSlop && abs(y-targetY) <= dragSlop {
				moved = 0
				continue
			}
			if pending[0] == x && pending[1] == y {
				moved++
			} else {
				pending[0], pending[1] = x, y
				moved = 0
			}
			if moved >= dragTicks-1 {
				if err := postJSON(*settingsURL, map[string]any{"position": "custom", "x": x, "y": y}); err == nil {
					targetX, targetY = x, y
					lastCfg.Position = "custom"
					lastCfg.X, lastCfg.Y = x, y
					settleUntil = time.Now().Add(settleFor)
				}
				moved = 0
			}
		}
	}()

	if err := app.Run(); err != nil {
		log.Fatalf("magpie-hud-desktop: %v", err)
	}
}

// trayIcon 画一个 32×32 的托盘图标：深色圆角方块 + 中间一点青绿，
// 与 HUD 的配色呼应，且不需要外部图片资源。
func trayIcon() []byte {
	const size = 32
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	bg := color.RGBA{0x28, 0x28, 0x28, 0xff}
	fg := color.RGBA{0x32, 0xd5, 0x83, 0xff}
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			// 圆角：四角 8px 半径外留空
			dx, dy := 0, 0
			switch {
			case x < 8 && y < 8:
				dx, dy = 8-x, 8-y
			case x >= size-8 && y < 8:
				dx, dy = x-(size-9), 8-y
			case x < 8 && y >= size-8:
				dx, dy = 8-x, y-(size-9)
			case x >= size-8 && y >= size-8:
				dx, dy = x-(size-9), y-(size-9)
			}
			if dx*dx+dy*dy > 64 {
				continue
			}
			img.Set(x, y, bg)
		}
	}
	// 中间一点
	for y := 12; y < 20; y++ {
		for x := 12; x < 20; x++ {
			dx, dy := x-16, y-16
			if dx*dx+dy*dy <= 16 {
				img.Set(x, y, fg)
			}
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

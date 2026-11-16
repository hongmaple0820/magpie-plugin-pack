// 鹊楼桌面 HUD 外壳：tao（窗口）+ wry / WebView2（页面）。
//
// 职责只有四件事，别的都交给页面（webapp/hud.html）：
//   1) 开一个无边框、置顶、不进任务栏、透明的窗口；
//   2) 把插件页面服务的 /hud.html 装进去；
//   3) 接页面的 IPC：拖动窗口、按页面量到的高度改窗口高、打开完整面板、隐藏；
//   4) 位置/尺寸跟插件设置走（platform::work_area + settings::place），拖动后写回。
//
// 为什么不再自己画（winit + softbuffer）：canvas 里没有次像素抗锯齿，中文小字糊；
// 审批按钮、输入框这些交互等于自己写一套控件库。WebView2 用系统的文字渲染，也直接
// 复用主面板那套设计 token。
//
// 端口是唯一入参（--port，默认 3477）；页面里的一切数据都由它自己去取。
mod http;
mod open_url;
mod platform;
mod settings;
mod tray;

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use tao::dpi::{LogicalPosition, LogicalSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::{Window, WindowBuilder};
use wry::WebViewBuilder;

/// 收起态高度：一条状态栏。页面脚本量到真实高度后会立刻报一次，覆盖这个值。
const BAR_H: f64 = 52.0;
/// 高度上下限：小于它窗口就点不中，大于它一定超出任何工作区
const MIN_H: f64 = 40.0;
const MAX_H: f64 = 900.0;
/// 拖动结束后这么久窗口坐标不再变化就算「松手了」，把落点写回设置
const DRAG_SETTLE: Duration = Duration::from_millis(600);
/// 设置轮询周期（面板里改位置/宽度后最多这么久生效）
const POLL: Duration = Duration::from_secs(2);
/// 事件循环空转上限：托盘菜单、拖动落点这些都靠它被看到
const TICK: Duration = Duration::from_millis(150);

/// 页面里按 Esc 收起来：WebView 拿到焦点时键盘事件到不了窗口，只能在页面侧接。
const INIT_JS: &str = r#"
window.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  ev.preventDefault();
  window.ipc?.postMessage(JSON.stringify({ cmd: "hide" }));
}, true);
"#;

fn port() -> u16 {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--port" {
            if let Some(v) = args.next() {
                if let Ok(p) = v.parse() {
                    return p;
                }
            }
        }
    }
    3477
}

/// 建窗那一刻的占位坐标：真实位置由 apply_geometry 给。
/// 这里跟 settings::MARGIN 对齐——万一 apply_geometry 没跑成，看起来也只是「贴着上边」，
/// 而不是停在一个莫名其妙的 10px 上。
fn top_center(w: f64) -> LogicalPosition<f64> {
    LogicalPosition::new(((1920.0 - w) / 2.0).max(0.0), settings::MARGIN)
}

fn main() {
    let port = port();

    // 自检：点击穿透在本平台是否可用（真实效果要人拿鼠标试，这里只验调用成败）
    if std::env::args().any(|a| a == "--selftest-clickthrough") {
        let el = EventLoop::new();
        let win = WindowBuilder::new()
            .with_visible(false)
            .with_transparent(true)
            .build(&el)
            .expect("自检建窗失败");
        let normal = platform::set_click_through(&win, false);
        let through = platform::set_click_through(&win, true);
        let back = platform::set_click_through(&win, false);
        println!("正常点击={normal} 穿透={through} 恢复={back}");
        std::process::exit(if normal && through && back { 0 } else { 1 });
    }

    let event_loop = EventLoop::new();

    // 单实例：命名互斥已经存在就说明有 HUD 在跑——把那个窗口叫到前面，本进程退出。
    // 不做这一步，双击两次就是两个 HUD 叠在一起，看起来像「窗口位置不对」。
    if !platform::claim_single_instance(port) {
        let raised = platform::focus_existing_hud();
        println!("已有 HUD 在运行（port={}），本实例退出；前置已有窗口={}", port, raised);
        std::process::exit(0);
    }

    // WebView2 默认在 exe 旁边建 `<exe>.WebView2/`：装在插件目录里就变成一堆缓存垃圾
    // （还会被打进 tarball）。指到 %LOCALAPPDATA%\magpie-hud\webview。
    #[cfg(windows)]
    {
        if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
            let base = std::env::var_os("LOCALAPPDATA")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            let dir = base.join("magpie-hud").join("webview");
            let _ = std::fs::create_dir_all(&dir);
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", dir);
        }
    }

    let mut cfg = settings::fetch(port);
    let (width, _) = cfg.size_f();

    #[allow(unused_mut)]
    let mut builder = WindowBuilder::new()
        // 单实例前置窗口靠这个标题找（platform::focus_existing_hud）
        .with_title("鹊楼")
        .with_decorations(false)
        .with_resizable(false)
        .with_always_on_top(true)
        .with_transparent(true)
        // 先藏起来：摆好位置再显示，免得用户看到窗口从屏幕中间跳过去
        .with_visible(false)
        .with_inner_size(LogicalSize::new(width, BAR_H))
        .with_position(top_center(width));
    #[cfg(windows)]
    {
        use tao::platform::windows::WindowBuilderExtWindows;
        builder = builder.with_skip_taskbar(true);
    }
    let window: Rc<Window> = match builder.build(&event_loop) {
        Ok(w) => Rc::new(w),
        Err(err) => {
            eprintln!("建窗失败：{err}");
            std::process::exit(1);
        }
    };

    // 页面报上来的高度：窗口高度以内容为准，设置里的 height 只当初始值
    let height = Rc::new(Cell::new(BAR_H));
    // 页面点了拖动 → 记下开始时间；主循环看到它就装观察器。
    // 句柄由 main 建：观察器在事件循环里开，页面只负责写时间。
    let drag_request: Rc<Cell<Option<Instant>>> = Rc::new(Cell::new(None));
    let url = format!("http://127.0.0.1:{port}/hud.html");
    // 变量要活到事件循环结束：WebView 一 drop，窗口里就只剩一片空白
    let _webview = match build_webview(&window, &height, &url, port, &drag_request) {
        Ok(wv) => wv,
        Err(err) => {
            // WebView2 缺失/被策略禁用时如实退出：插件会落 .failed 标记并在面板里显示原因
            eprintln!("WebView2 初始化失败：{err}");
            std::process::exit(1);
        }
    };

    // 显示器清单上报给插件，页面才能渲染「显示器」选择器（>1 块屏时才显示）
    report_displays(port, &window);
    apply_geometry(&window, &cfg, height.get());

    // 托盘：Esc 隐藏之后还能从这里回来
    let tray = tray::build();

    let mut last_poll = Instant::now();
    let mut geometry_done = false;
    let mut drag: Option<DragWatch> = None;
    let mut auto_hidden = false;
    let mut user_hidden = false;
    // 穿透后窗口收不到鼠标，唯一能把它关掉的入口就是托盘菜单——所以状态放在这里
    let mut click_through = false;
    let mut last_visible = false;

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + TICK);
        match event {
            Event::WindowEvent { event, .. } => match event {
                WindowEvent::CloseRequested => *control_flow = ControlFlow::Exit,
                _ => {}
            },
            Event::MainEventsCleared => {
                // 首轮：窗口已经 map，这时设位置才算数（Windows 上建窗时的坐标会被忽略）
                if !geometry_done {
                    apply_geometry(&window, &cfg, height.get());
                    geometry_done = true;
                }

                // 托盘菜单（只有 Windows/macOS 有托盘实现）
                #[cfg(any(windows, target_os = "macos"))]
                while let Ok(ev) = tray_icon::menu::MenuEvent::receiver().try_recv() {
                    if let Some(t) = &tray {
                        if ev.id == t.toggle {
                            user_hidden = !user_hidden;
                        } else if ev.id == t.panel {
                            open_url::panel(port);
                        } else if ev.id == t.through {
                            click_through = !click_through;
                            if !platform::set_click_through(&window, click_through) {
                                click_through = false; // 本平台设不了就别记成「已穿透」
                                eprintln!("点击穿透在这个环境里设不了");
                            }
                        } else if ev.id == t.quit {
                            *control_flow = ControlFlow::Exit;
                        }
                    }
                }

                // 可见性一处算：自动（全屏/演示）与用户意图（Esc / 托盘）互不覆盖
                let visible = !(user_hidden || auto_hidden);
                if visible != last_visible {
                    window.set_visible(visible);
                    last_visible = visible;
                }

                if last_poll.elapsed() >= POLL {
                    last_poll = Instant::now();

                    // 全屏/演示时自动收起，退出后自动回来——不打断用户在看的电影或演示
                    auto_hidden = platform::fullscreen_app_active();

                    // 拖动落点：坐标稳定 DRAG_SETTLE 之后写回设置
                    if drag.is_none() {
                        if let Some(at) = drag_request.take() {
                            drag = Some(DragWatch::started_at(at));
                        }
                    }
                    if let Some(d) = drag.as_mut() {
                        if let Some(placed) = d.observe(&window, port) {
                            cfg.position = "custom".into();
                            cfg.screen = placed.screen.clone();
                            cfg.x = placed.x.round() as i32;
                            cfg.y = placed.y.round() as i32;
                            cfg.width = placed.w.round() as i32;
                            cfg.height = placed.h.round() as i32;
                            drag = None;
                        }
                    }

                    let next = settings::fetch(port);
                    let changed = next.position != cfg.position
                        || next.notch != cfg.notch
                        || next.auto_shape != cfg.auto_shape
                        || next.width != cfg.width
                        || next.height != cfg.height
                        // 拖完写回的落点也要认：否则面板里改了 x/y 或换了屏，窗口不动
                        || next.screen != cfg.screen
                        || next.x != cfg.x
                        || next.y != cfg.y;
                    if changed {
                        cfg = next;
                        apply_geometry(&window, &cfg, height.get());
                    }
                }
            }
            _ => {}
        }
    });
}

/// 装上页面并接好 IPC。
///
/// 三个指令都是页面为了「看起来不像个网页」才需要的：拖动、改高、开面板/收起。
/// 参数不合法时打印出来而不是静默丢弃——HUD 上出问题的时候，这行 stderr 是唯一线索。
fn build_webview(
    window: &Rc<Window>,
    height: &Rc<Cell<f64>>,
    url: &str,
    port: u16,
    started: &Rc<Cell<Option<Instant>>>,
) -> Result<wry::WebView, wry::Error> {
    let win = Rc::clone(window);
    let h = Rc::clone(height);
    let started_ipc = Rc::clone(started);
    WebViewBuilder::new()
        .with_url(url)
        .with_transparent(true)
        .with_background_color((0, 0, 0, 0))
        .with_devtools(false)
        .with_initialization_script(INIT_JS)
        .with_ipc_handler(move |req: wry::http::Request<String>| {
            let Some(msg) = parse_ipc(req.body(), port) else {
                eprintln!("HUD IPC 不是 JSON：{:?}", req.body());
                return;
            };
            match msg {
                Ipc::Drag => {
                    // 系统模态拖动：拿到鼠标后自己接管移动，直到松手
                    if let Err(err) = win.drag_window() {
                        eprintln!("拖动失败：{err}");
                    }
                    started_ipc.set(Some(Instant::now()));
                }
                Ipc::Resize(want) => {
                    h.set(want);
                    let width = logical_width(&win);
                    win.set_inner_size(LogicalSize::new(width, want));
                }
                Ipc::Open(target) => open_url::open(&target),
                Ipc::OpenSession(id) => open_url::session(port, &id),
                Ipc::OpenPanel => open_url::panel(port),
                Ipc::Hide => hide(&win),
                Ipc::Log(text) => eprintln!("HUD 页面：{text}"),
                Ipc::Unknown(other) => eprintln!("未知 IPC 指令：{other:?}"),
            }
        })
        .build(&**window)
}

/// 页面发来的一条 IPC 指令（已校验过来源与范围）。
///
/// 为什么单独抽出来：WebView 的 ipc 回调里拿不到单测，而这里有三条容易错的边界——
/// 高度要 clamp、`open` 只许开本机这一个服务、非 JSON 不能当成「未知指令」静默吞掉。
#[derive(Debug, PartialEq)]
enum Ipc {
    Drag,
    Resize(f64),
    Open(String),
    /// 点会话行：打开完整面板并定位到这条会话（id 由 Rust 侧编码，页面不用管转义）
    OpenSession(String),
    /// 请求打开的地址不在白名单里：退回打开完整面板（不能什么都不做，人会以为按钮坏了）
    OpenPanel,
    Hide,
    /// 页面自己报的错（fetch 失败、脚本异常）：没有它，窗口里只剩一排「—」，
    /// 分不清是服务没起来还是页面脚本挂了
    Log(String),
    Unknown(String),
}

/// 解析一条 IPC。返回 None 表示这条不是 JSON（调用方要打日志，不能静默丢）。
fn parse_ipc(body: &str, port: u16) -> Option<Ipc> {
    let msg: serde_json::Value = serde_json::from_str(body).ok()?;
    let cmd = msg.get("cmd").and_then(|c| c.as_str());
    Some(match cmd {
        Some("drag") => Ipc::Drag,
        Some("resize") => {
            let want = msg
                .get("h")
                .and_then(|x| x.as_f64())
                .unwrap_or(BAR_H)
                .clamp(MIN_H, MAX_H);
            Ipc::Resize(want)
        }
        Some("open") if msg.get("id").and_then(|x| x.as_str()).is_some() => {
            Ipc::OpenSession(msg.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string())
        }
        Some("open") => {
            let target = msg.get("url").and_then(|x| x.as_str()).unwrap_or("");
            // 只允许打开本机这个服务：页面上不该有能打开任意 URL 的能力
            if target.starts_with(&format!("http://127.0.0.1:{port}/")) {
                Ipc::Open(target.to_string())
            } else {
                Ipc::OpenPanel
            }
        }
        Some("hide") => Ipc::Hide,
        Some("log") => Ipc::Log(
            msg.get("text")
                .and_then(|x| x.as_str())
                .unwrap_or("<empty>")
                .to_string(),
        ),
        Some(other) => Ipc::Unknown(other.to_string()),
        None => Ipc::Unknown("<no cmd>".to_string()),
    })
}

/// 窗口当前宽度（逻辑像素）：改高度时宽度保持不变
fn logical_width(window: &Window) -> f64 {
    let scale = window.scale_factor();
    window.inner_size().width as f64 / scale
}

/// 拖动落点观察器。
///
/// 页面发 `drag` 之后窗口由系统拖着走，我们拿不到「松手」事件（鼠标事件在 WebView 里），
/// 所以只能看坐标：停住 DRAG_SETTLE 之后认为拖动结束，把落点写回设置。
struct DragWatch {
    started: Instant,
    last: Option<(i32, i32)>,
    changed_at: Instant,
}

struct Placed {
    screen: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl DragWatch {
    /// 以「页面按下拖动的那一刻」为起点：settle 判定要从那一刻开始算，
    /// 否则按住不动的那两秒会被当成「已经停稳」。
    fn started_at(started: Instant) -> Self {
        Self { started, last: None, changed_at: started }
    }

    /// 还在动就返回 None；停住并已写回设置就返回落点。
    fn observe(&mut self, window: &Window, port: u16) -> Option<Placed> {
        let Ok(pos) = window.outer_position() else {
            return None;
        };
        let now = Instant::now();
        let cur = (pos.x, pos.y);
        if self.last != Some(cur) {
            self.last = Some(cur);
            self.changed_at = now;
            return None;
        }
        if now.duration_since(self.changed_at) < DRAG_SETTLE
            || now.duration_since(self.started) < DRAG_SETTLE
        {
            return None;
        }
        let scale = window.scale_factor();
        let size = window.inner_size();
        let placed = Placed {
            screen: window.current_monitor().map(|m| monitor_id(&m)).unwrap_or_default(),
            x: pos.x as f64 / scale,
            y: pos.y as f64 / scale,
            w: size.width as f64 / scale,
            h: size.height as f64 / scale,
        };
        if !settings::save_placement(port, &placed.screen, placed.x, placed.y, placed.w, placed.h) {
            eprintln!("拖动落点没能写回设置（服务没响应？）");
        }
        Some(placed)
    }
}

/// 把设置换算成窗口尺寸与位置并应用。
///
/// 单位注意：tao 的 monitor.position()/size() 是**物理像素**，而窗口坐标/尺寸走
/// **逻辑像素**。高 DPI 下两者差 1.25/1.5 倍——直接拿物理当逻辑用，125% 缩放时窗口
/// 会算到屏幕右边外面去。所以先把显示器矩形按 scale_factor 折成逻辑，再交给
/// settings::place 求位置。
///
/// 高度用页面报上来的值（height），不吃设置里的 height：窗口高度应当等于内容高度。
fn apply_geometry(window: &Window, cfg: &settings::Settings, height: f64) {
    let (w, _) = cfg.size_f();
    let h = height.clamp(MIN_H, MAX_H);
    let picked = if cfg.screen.is_empty() {
        None
    } else {
        window.available_monitors().find(|m| monitor_id(m) == cfg.screen)
    };
    let handle = picked
        .or_else(|| window.current_monitor())
        .or_else(|| window.primary_monitor());
    let (mon, work) = match handle.as_ref() {
        Some(m) => {
            let scale = m.scale_factor();
            let pos = m.position();
            let siz = m.size();
            let mon = settings::Rect {
                x: pos.x as f64 / scale,
                y: pos.y as f64 / scale,
                w: siz.width as f64 / scale,
                h: siz.height as f64 / scale,
            };
            // 工作区（扣任务栏）拿不到就退回整屏：宁可靠边，也不要压在任务栏下
            let (wx, wy, ww, wh) =
                platform::work_area(m).unwrap_or((pos.x, pos.y, siz.width, siz.height));
            let work = settings::Rect {
                x: wx as f64 / scale,
                y: wy as f64 / scale,
                w: ww as f64 / scale,
                h: wh as f64 / scale,
            };
            (mon, work)
        }
        None => (
            settings::Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 },
            settings::Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 },
        ),
    };
    // place() 用的是设置里的尺寸（含高度）；窗口实际高度跟着内容走，
    // 所以按实际高度重新算一次垂直位置，别让「贴底」的两个坐标对不上。
    let mut probe = cfg.clone();
    probe.height = h.round() as i32;
    if !probe.auto_shape {
        probe.width = w.round() as i32;
    }
    let (x, y) = probe.place(mon, work);
    window.set_inner_size(LogicalSize::new(w, h));
    window.set_outer_position(LogicalPosition::new(x, y));
}

fn hide(window: &Window) {
    window.set_visible(false);
}

/// 显示器标识：优先用系统名，退化为尺寸+位置（保证同一块屏每次都算出同一个 id）
fn monitor_id(m: &tao::monitor::MonitorHandle) -> String {
    if let Some(name) = m.name() {
        if !name.is_empty() {
            return name;
        }
    }
    format!("{}_{}x{}", m.position().x, m.size().width, m.size().height)
}

/// 把显示器清单 POST 给插件服务（页面据此渲染选择器）
fn report_displays(port: u16, window: &Window) {
    let primary = window.primary_monitor().map(|m| monitor_id(&m));
    let mut screens = Vec::new();
    for m in window.available_monitors() {
        let id = monitor_id(&m);
        screens.push(serde_json::json!({
            "id": id,
            "name": id,
            "width": m.size().width,
            "height": m.size().height,
            "primary": primary.as_deref() == Some(id.as_str()),
        }));
    }
    let body = serde_json::json!({ "screens": screens }).to_string();
    let _ = http::post(port, "/api/display", &body);
}

#[cfg(test)]
mod ipc_tests {
    use super::{parse_ipc, Ipc, BAR_H, MAX_H, MIN_H};

    fn at(port: u16, body: &str) -> Ipc {
        parse_ipc(body, port).expect("合法 JSON 不该返回 None")
    }

    #[test]
    fn parses_drag_and_hide() {
        assert_eq!(at(3477, r#"{"cmd":"drag"}"#), Ipc::Drag);
        assert_eq!(at(3477, r#"{"cmd":"hide"}"#), Ipc::Hide);
    }

    #[test]
    fn resize_uses_page_height() {
        assert_eq!(at(3477, r#"{"cmd":"resize","h":312.4}"#), Ipc::Resize(312.4));
    }

    #[test]
    fn resize_clamps_both_ends() {
        assert_eq!(at(3477, r#"{"cmd":"resize","h":10}"#), Ipc::Resize(MIN_H));
        assert_eq!(at(3477, r#"{"cmd":"resize","h":9000}"#), Ipc::Resize(MAX_H));
    }

    #[test]
    fn resize_falls_back_to_bar_height() {
        assert_eq!(at(3477, r#"{"cmd":"resize"}"#), Ipc::Resize(BAR_H));
        assert_eq!(at(3477, r#"{"cmd":"resize","h":"tall"}"#), Ipc::Resize(BAR_H));
    }

    #[test]
    fn open_only_accepts_this_port() {
        assert_eq!(
            at(3477, r#"{"cmd":"open","url":"http://127.0.0.1:3477/"}"#),
            Ipc::Open("http://127.0.0.1:3477/".to_string())
        );
    }

    #[test]
    fn open_rejects_foreign_targets() {
        // 别的端口、别的协议、外站、空字符串 —— 一律退回落完整面板
        for body in [
            r#"{"cmd":"open","url":"http://127.0.0.1:9999/"}"#,
            r#"{"cmd":"open","url":"file:///C:/Windows/"}"#,
            r#"{"cmd":"open","url":"https://evil.example/"}"#,
            r#"{"cmd":"open"}"#,
        ] {
            assert_eq!(at(3477, body), Ipc::OpenPanel, "{body}");
        }
    }

    #[test]
    fn unknown_command_is_reported_not_swallowed() {
        assert_eq!(at(3477, r#"{"cmd":"launch-missiles"}"#), Ipc::Unknown("launch-missiles".to_string()));
        assert_eq!(at(3477, r#"{"h":120}"#), Ipc::Unknown("<no cmd>".to_string()));
    }

    #[test]
    fn parses_page_log() {
        assert_eq!(at(3477, r#"{"cmd":"log","text":"state: HTTP 403"}"#), Ipc::Log("state: HTTP 403".to_string()));
        assert_eq!(at(3477, r#"{"cmd":"log"}"#), Ipc::Log("<empty>".to_string()));
    }

    #[test]
    fn open_with_session_id_targets_that_session() {
        assert_eq!(
            at(3477, r#"{"cmd":"open","id":"abc-123"}"#),
            Ipc::OpenSession("abc-123".to_string())
        );
    }

    #[test]
    fn non_json_is_none() {
        assert!(parse_ipc("not json", 3477).is_none());
        assert!(parse_ipc("", 3477).is_none());
    }
}

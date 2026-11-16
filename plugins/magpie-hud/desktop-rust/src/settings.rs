// HUD 的位置与尺寸来源：插件服务的 /api/settings（用户在同一份设置里改）。
//
// 形状跟吸附边走——这是用户明确要求过的：
//   贴顶 → 560×160（宽扁）
//   贴左右 → 240×520（窄高）
//   刘海 → 560×140（更矮、贴物理顶）
//   custom → 用设置里存的 x/y
// autoShape=false 时用设置里显式给的宽高。
use crate::http;

#[derive(Debug, Clone)]
pub struct Settings {
    pub position: String,
    pub screen: String,
    pub notch: bool,
    pub auto_shape: bool,
    pub width: i32,
    pub height: i32,
    pub x: i32,
    pub y: i32,
    /// 芯片顺序（用户在 HUD 里拖动排序后写回；空 = 用默认顺序）
    pub hud_agents: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            position: "top-center".into(),
            screen: String::new(),
            notch: false,
            auto_shape: true,
            width: 560,
            height: 160,
            x: 0,
            y: 0,
            hud_agents: Vec::new(),
        }
    }
}

pub fn fetch(port: u16) -> Settings {
    let mut s = Settings::default();
    let Some(body) = http::get(port, "/api/settings") else {
        return s;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) else {
        return s;
    };
    if let Some(p) = v.get("position").and_then(|x| x.as_str()) {
        s.position = p.to_string();
    }
    if let Some(sc) = v.get("screen").and_then(|x| x.as_str()) {
        s.screen = sc.to_string();
    }
    s.notch = v.get("notch").and_then(|x| x.as_bool()).unwrap_or(false);
    s.auto_shape = v.get("autoShape").and_then(|x| x.as_bool()).unwrap_or(true);
    if let Some(w) = v.get("width").and_then(|x| x.as_i64()) {
        s.width = w as i32;
    }
    if let Some(h) = v.get("height").and_then(|x| x.as_i64()) {
        s.height = h as i32;
    }
    if let Some(x) = v.get("x").and_then(|x| x.as_i64()) {
        s.x = x as i32;
    }
    if let Some(y) = v.get("y").and_then(|x| x.as_i64()) {
        s.y = y as i32;
    }
    if let Some(arr) = v.get("hudAgents").and_then(|x| x.as_array()) {
        s.hud_agents = arr
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .take(24)
            .collect();
    }
    s
}


impl Settings {
    pub fn size(&self) -> (u32, u32) {
        if !self.auto_shape && self.width > 0 && self.height > 0 {
            return (self.width as u32, self.height as u32);
        }
        if self.notch {
            return (560, 140);
        }
        if self.position.starts_with("top") {
            return (560, 160);
        }
        if self.position == "left" || self.position == "right" {
            return (240, 520);
        }
        (self.width.max(200) as u32, self.height.max(80) as u32)
    }

    /// 逻辑像素尺寸（winit 的 LogicalSize 用它；monitor 的物理像素在 main 里按 DPI 折过）
    pub fn size_f(&self) -> (f64, f64) {
        let (w, h) = self.size();
        (w as f64, h as f64)
    }

    /// 算出窗口左上角（逻辑像素）。mon 是整屏，work 是工作区（已扣掉任务栏）：
    /// 贴边一律留在工作区内，四条边各留 MARGIN——压在任务栏或屏幕外面等于没显示。
    ///
    /// 存过坐标的 custom 也可能是另一块屏的（拔显示器、改分辨率、跨屏拖动之后），
    /// 所以 custom 同样要 clamp，而不是原样相信设置文件。
    pub fn place(&self, mon: Rect, work: Rect) -> (f64, f64) {
        let (w, h) = self.size_f();
        let (mut x, mut y) = match self.position.as_str() {
            "custom" => (self.x as f64, self.y as f64),
            "top-left" => (work.x + MARGIN, work.y + MARGIN),
            "top-right" => (work.right() - w - MARGIN, work.y + MARGIN),
            "left" => (work.x + MARGIN, work.y + (work.h - h) / 2.0),
            "right" => (work.right() - w - MARGIN, work.y + (work.h - h) / 2.0),
            _ => (work.x + (work.w - w) / 2.0, work.y + MARGIN),
        };
        if w + 2.0 * MARGIN <= work.w {
            x = x.clamp(work.x + MARGIN, work.right() - w - MARGIN);
        } else {
            x = work.x; // 窗口比工作区还宽：贴左，宁可右边出血也不留负边距
        }
        // 刘海模式贴物理顶端（任务栏在底部/侧边时它才是真正的「顶」），不走 margin
        if self.notch && !matches!(self.position.as_str(), "custom" | "left" | "right") {
            y = mon.y;
        } else if h + 2.0 * MARGIN <= work.h {
            y = y.clamp(work.y + MARGIN, work.bottom() - h - MARGIN);
        } else {
            y = work.y;
        }
        (x, y)
    }
}

/// 逻辑像素矩形（左上角 + 宽高）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn right(&self) -> f64 {
        self.x + self.w
    }
    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }
}

/// 贴边留白。8px 让 HUD 不贴着屏幕边缘（Windows 贴边会触发贴靠手势/圆角裁切）。
pub const MARGIN: f64 = 8.0;

/// 拖动之后把落点写回设置：存屏幕 id + 逻辑坐标 + 尺寸，下次启动还在原地。
/// 宽高按服务端的合法区间收一次，免得多显示器高分屏下存进越界值再被服务端改写。
pub fn save_placement(port: u16, screen: &str, x: f64, y: f64, w: f64, h: f64) -> bool {
    let body = serde_json::json!({
        "position": "custom",
        "screen": screen,
        "x": x.round() as i32,
        "y": y.round() as i32,
        "width": (w.round() as i32).clamp(240, 900),
        "height": (h.round() as i32).clamp(120, 900),
    })
    .to_string();
    crate::http::post(port, "/api/settings", &body)
}

#[cfg(test)]
mod placement_tests {
    use super::*;

    fn win(position: &str, x: i32, y: i32) -> Settings {
        Settings { position: position.into(), x, y, ..Settings::default() }
    }
    // 1920×1080 屏，底部 40px 任务栏 → 工作区逻辑高度 1040
    fn screen() -> (Rect, Rect) {
        (Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 }, Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1040.0 })
    }

    #[test]
    fn top_center_sits_under_the_margin_and_is_centered() {
        let (mon, work) = screen();
        let (x, y) = win("top-center", 0, 0).place(mon, work);
        assert_eq!(y, 8.0);
        assert_eq!(x, (1920.0 - 560.0) / 2.0);
    }

    #[test]
    fn top_right_keeps_the_right_margin() {
        let (mon, work) = screen();
        let (x, y) = win("top-right", 0, 0).place(mon, work);
        assert_eq!(x, 1920.0 - 560.0 - 8.0);
        assert_eq!(y, 8.0);
    }

    #[test]
    fn custom_beyond_right_and_bottom_is_pulled_back_inside() {
        let (mon, work) = screen();
        let (x, y) = win("custom", 3000, 2000).place(mon, work);
        assert_eq!(x, 1920.0 - 560.0 - 8.0);
        assert_eq!(y, 1040.0 - 160.0 - 8.0, "不能压到任务栏下面");
    }

    #[test]
    fn negative_custom_coords_land_inside() {
        let (mon, work) = screen();
        let (x, y) = win("custom", -400, -300).place(mon, work);
        assert_eq!((x, y), (8.0, 8.0));
    }

    #[test]
    fn custom_from_another_monitor_fits_the_new_one() {
        // 1920 宽上存的位置，换到 1366×768 的副屏
        let mon = Rect { x: 1920.0, y: 0.0, w: 1366.0, h: 768.0 };
        let work = Rect { x: 1920.0, y: 0.0, w: 1366.0, h: 728.0 };
        let (x, y) = win("custom", 2800, 600).place(mon, work);
        assert_eq!(x, 1920.0 + 1366.0 - 560.0 - 8.0);
        assert_eq!(y, 728.0 - 160.0 - 8.0);
        assert!(x >= work.x && x + 560.0 <= work.right() && y + 160.0 <= work.bottom());
    }

    #[test]
    fn scale_125_percent_uses_logical_bounds() {
        // 2560×1440 物理、125% → 2048×1152 逻辑；任务栏 48 物理 = 38.4 逻辑
        let mon = Rect { x: 0.0, y: 0.0, w: 2048.0, h: 1152.0 };
        let work = Rect { x: 0.0, y: 0.0, w: 2048.0, h: 1152.0 - 38.4 };
        let (x, _) = win("top-right", 0, 0).place(mon, work);
        assert_eq!(x, 2048.0 - 560.0 - 8.0);
        assert!(x + 560.0 <= work.right());
    }

    #[test]
    fn scale_150_percent_keeps_margins_on_small_logical_area() {
        // 1920×1080 物理、150% → 1280×720 逻辑：560 宽的 HUD 仍要留两边 8px
        let mon = Rect { x: 0.0, y: 0.0, w: 1280.0, h: 720.0 };
        let work = Rect { x: 0.0, y: 0.0, w: 1280.0, h: 720.0 - 32.0 };
        let (x, y) = win("top-center", 0, 0).place(mon, work);
        assert_eq!(x, (1280.0 - 560.0) / 2.0);
        assert_eq!(y, 8.0);
        assert!(x >= 8.0 && x + 560.0 <= work.right() - 8.0);
    }

    #[test]
    fn notch_is_flush_with_the_physical_top_and_wider_than_work_still_fits() {
        let (mon, work) = screen();
        let s = Settings { notch: true, ..Settings::default() };
        let (_, y) = s.place(mon, work);
        assert_eq!(y, 0.0, "刘海模式贴物理顶端");

        // 窗口比工作区宽：贴左，不产生负边距
        let narrow = Rect { x: 0.0, y: 0.0, w: 480.0, h: 400.0 };
        let (x, _) = s.place(mon, narrow);
        assert_eq!(x, 0.0);
    }
}


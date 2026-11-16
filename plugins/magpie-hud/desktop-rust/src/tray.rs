// 系统托盘：右下角图标 + 菜单（显示/隐藏、打开面板、退出）。
//
// tray-icon 0.19 在这套工具链上能编译（依赖 windows-sys 0.59，没有踩 0.61 的 raw-dylib 坑）。
// 图标在代码里生成（32×32 深色圆角方块 + 青绿点），不依赖外部资源文件。
#[cfg(any(windows, target_os = "macos"))]
use tray_icon::menu::{Menu, MenuId, MenuItem};
#[cfg(any(windows, target_os = "macos"))]
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

#[cfg(any(windows, target_os = "macos"))]
pub struct Tray {
    // 只为了持有生命周期：图标对象一 drop，托盘图标就消失（不是没用到）
    #[allow(dead_code)]
    pub icon: TrayIcon,
    pub toggle: MenuId,
    pub panel: MenuId,
    /// 点击穿透开关：HUD 挡住屏幕时让鼠标穿过去；再点一次恢复（只能从托盘点回来）
    pub through: MenuId,
    pub quit: MenuId,
}

#[cfg(any(windows, target_os = "macos"))]
fn make_icon() -> Icon {
    const S: u32 = 32;
    let mut rgba = vec![0u8; (S * S * 4) as usize];
    for y in 0..S {
        for x in 0..S {
            let i = ((y * S + x) * 4) as usize;
            // 圆角：四角 8px 半径外留空
            let (mut dx, mut dy) = (0i32, 0i32);
            if x < 8 && y < 8 {
                dx = 8 - x as i32;
                dy = 8 - y as i32;
            } else if x >= S - 8 && y < 8 {
                dx = x as i32 - (S as i32 - 9);
                dy = 8 - y as i32;
            } else if x < 8 && y >= S - 8 {
                dx = 8 - x as i32;
                dy = y as i32 - (S as i32 - 9);
            } else if x >= S - 8 && y >= S - 8 {
                dx = x as i32 - (S as i32 - 9);
                dy = y as i32 - (S as i32 - 9);
            }
            if dx * dx + dy * dy > 64 {
                continue;
            }
            // 中间一点：青绿
            let cx = x as i32 - 16;
            let cy = y as i32 - 16;
            let (r, g, b) = if cx * cx + cy * cy <= 16 {
                (0x32, 0xD5, 0x83)
            } else {
                (0x28, 0x28, 0x28)
            };
            rgba[i] = r;
            rgba[i + 1] = g;
            rgba[i + 2] = b;
            rgba[i + 3] = 255;
        }
    }
    Icon::from_rgba(rgba, S, S).expect("icon")
}

#[cfg(any(windows, target_os = "macos"))]
pub fn build() -> Option<Tray> {
    let menu = Menu::new();
    let toggle = MenuItem::new("显示 / 隐藏 HUD", true, None);
    let panel = MenuItem::new("打开完整面板", true, None);
    let through = MenuItem::new("点击穿透（开 / 关）", true, None);
    let quit = MenuItem::new("退出", true, None);
    menu.append(&toggle).ok()?;
    menu.append(&panel).ok()?;
    menu.append(&through).ok()?;
    menu.append(&quit).ok()?;
    let icon = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip("鹊楼 · agent HUD")
        .with_icon(make_icon())
        .build()
        .ok()?;
    Some(Tray {
        icon,
        toggle: toggle.id().clone(),
        panel: panel.id().clone(),
        through: through.id().clone(),
        quit: quit.id().clone(),
    })
}

/// 没有托盘实现的平台：返回 None，调用方据此把「隐藏」退化成「退出」。
#[cfg(not(any(windows, target_os = "macos")))]
pub struct Tray;

#[cfg(not(any(windows, target_os = "macos")))]
pub fn build() -> Option<Tray> {
    None
}

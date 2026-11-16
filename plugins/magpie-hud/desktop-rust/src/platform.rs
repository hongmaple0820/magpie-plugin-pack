// 平台相关的小能力：点击穿透、全屏应用检测、工作区、单实例。
//
// 点击穿透在 tao 里没有对应 API（winit 的 set_cursor_hittest 没被 tao 暴露），
// 所以这里直接改扩展样式：WS_EX_TRANSPARENT 让鼠标事件落到下面的窗口，
// WS_EX_LAYERED 是 Windows 允许它生效的前提。
// 全屏检测用 SHQueryUserNotificationState：这是系统给「要不要弹通知」的权威回答，
// 比自己去比窗口尺寸靠谱（能识别独占全屏、演示模式）。
use tao::window::Window;

/// on=true 表示开启穿透（HUD 不再接收鼠标）。返回是否设置成功。
#[cfg(windows)]
pub fn set_click_through(window: &Window, on: bool) -> bool {
    use tao::platform::windows::WindowExtWindows;

    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_TRANSPARENT: isize = 0x0000_0020;
    const WS_EX_LAYERED: isize = 0x0008_0000;

    #[link(name = "user32")]
    extern "system" {
        fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
    }

    let hwnd = window.hwnd();
    if hwnd == 0 {
        return false;
    }
    let mut style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    if on {
        style |= WS_EX_TRANSPARENT | WS_EX_LAYERED;
    } else {
        style &= !WS_EX_TRANSPARENT;
    }
    unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style) };
    // SetWindowLongPtr 的返回值 0 既可能是「旧值就是 0」也可能是失败，
    // 所以不靠返回值判断，直接把扩展样式读回来核对目标位。
    let after = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    ((after & WS_EX_TRANSPARENT) != 0) == on
}

#[cfg(not(windows))]
pub fn set_click_through(_window: &Window, _on: bool) -> bool {
    false // X11/Wayland 没有统一的「整窗穿透」开关；HUD 在那边本来也不是主路径
}

/// 系统当前是否处于「不该打扰」的状态（全屏 / 演示）。
#[cfg(windows)]
pub fn fullscreen_app_active() -> bool {
    let mut state: i32 = 0;
    // 直接链接 shell32：比 LoadLibrary/GetProcAddress 简单，mingw 提供 libshell32.a
    let hr = unsafe { SHQueryUserNotificationState(&mut state) };
    hr == 0 && should_hide(state)
}

#[cfg(windows)]
#[link(name = "shell32")]
extern "system" {
    fn SHQueryUserNotificationState(state: *mut i32) -> i32;
}

#[cfg(not(windows))]
pub fn fullscreen_app_active() -> bool {
    false
}

/// 某块屏的工作区（扣掉任务栏），**物理像素**。
/// tao 的 MonitorHandle 只给整屏尺寸，没有工作区概念；Windows 上
/// GetMonitorInfoW 的 rcWork 就是系统自己去算的答案，比按尺寸猜任务栏在哪靠谱。
/// 拿不到就返回 None，调用方回落到整屏——总比不显示强。
#[cfg(windows)]
pub fn work_area(monitor: &tao::monitor::MonitorHandle) -> Option<(i32, i32, u32, u32)> {
    use tao::platform::windows::MonitorHandleExtWindows;

    #[repr(C)]
    struct RECT {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    struct MONITORINFO {
        cb_size: u32,
        rc_monitor: RECT,
        rc_work: RECT,
        flags: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetMonitorInfoW(monitor: *mut core::ffi::c_void, info: *mut MONITORINFO) -> i32;
    }

    let mut info = MONITORINFO {
        cb_size: std::mem::size_of::<MONITORINFO>() as u32,
        rc_monitor: RECT { left: 0, top: 0, right: 0, bottom: 0 },
        rc_work: RECT { left: 0, top: 0, right: 0, bottom: 0 },
        flags: 0,
    };
    // hmonitor 是 isize 起的裸句柄；传指针类型只是为了让 ABI 对上
    let ok = unsafe { GetMonitorInfoW(monitor.hmonitor() as *mut core::ffi::c_void, &mut info) };
    if ok == 0 {
        return None;
    }
    let w = info.rc_work.right - info.rc_work.left;
    let h = info.rc_work.bottom - info.rc_work.top;
    if w <= 0 || h <= 0 {
        return None;
    }
    Some((info.rc_work.left, info.rc_work.top, w as u32, h as u32))
}

#[cfg(not(windows))]
pub fn work_area(_monitor: &tao::monitor::MonitorHandle) -> Option<(i32, i32, u32, u32)> {
    None // X11 没有「工作区」的通用答案，用整屏
}

/// 已经有 HUD 在跑时，把那个窗口提到前面——第二实例自己退出，用户看到的是同一个窗口。
/// 找不到窗口（同名程序、别的会话）也返回 false，调用方照常退出即可。
#[cfg(windows)]
pub fn focus_existing_hud() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class: *const u16, title: *const u16) -> isize;
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
        fn SetForegroundWindow(hwnd: isize) -> i32;
    }
    let title: Vec<u16> = "鹊楼\0".encode_utf16().collect();
    let hwnd = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
    if hwnd == 0 {
        return false;
    }
    unsafe {
        ShowWindow(hwnd, 5); // SW_SHOW：托盘里藏起来过也能叫回来
        SetForegroundWindow(hwnd);
    }
    true
}

#[cfg(not(windows))]
pub fn focus_existing_hud() -> bool {
    false
}

/// 单实例：同一个端口只允许一个 HUD 进程。
///
/// 用命名互斥而不是锁文件：进程崩掉时内核自动释放，不会留下「锁着但没人跑」的死锁文件。
/// 名字里带端口——不同服务的 HUD 各是各的，不该互相拦。
/// 返回 false 表示已有实例在跑，本进程应当退出。
#[cfg(windows)]
pub fn claim_single_instance(port: u16) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attrs: *mut core::ffi::c_void, owner: i32, name: *const u16) -> isize;
        fn GetLastError() -> u32;
    }
    const ERROR_ALREADY_EXISTS: u32 = 183;
    let name: Vec<u16> = format!("Local\\magpie-hud-{port}\0").encode_utf16().collect();
    let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };
    if handle == 0 {
        return true; // 创建失败（权限之类）不该拦着用户用 HUD
    }
    unsafe { GetLastError() != ERROR_ALREADY_EXISTS }
}

#[cfg(not(windows))]
pub fn claim_single_instance(_port: u16) -> bool {
    true // TODO: Linux 抽象 socket / macOS flock（后续，先只保证 Windows 不重复起）
}

/// 判定逻辑单独抽出来，方便单测（不依赖 Windows）
pub fn should_hide(notification_state: i32) -> bool {
    matches!(notification_state, 3 | 4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_only_in_fullscreen_or_presentation() {
        assert!(!should_hide(1), "NOT_PRESENT");
        assert!(!should_hide(2), "BUSY 不该隐藏（用户可能只是忙）");
        assert!(should_hide(3), "D3D 全屏");
        assert!(should_hide(4), "演示模式");
        assert!(!should_hide(5), "ACCEPTS_NOTIFICATIONS");
        assert!(!should_hide(6), "QUIET_TIME");
        assert!(!should_hide(7), "APP");
    }
}

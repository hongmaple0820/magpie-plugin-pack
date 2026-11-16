// 打开「完整面板」：用系统默认浏览器，不引 opener crate（同样是为躲 windows-sys 链）。
use std::process::Command;

/// 打开面板并直接定位到某个会话（页面读 ?session= 后弹出该会话详情）
pub fn session(port: u16, id: &str) {
    let url = format!(
        "http://127.0.0.1:{}/?session={}",
        port,
        urlencode(id)
    );
    spawn(&url);
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

pub fn panel(port: u16) {
    spawn(&format!("http://127.0.0.1:{}/", port));
}

/// 打开页面通过 IPC 要求的地址（调用方已经确认是本机这个服务）
pub fn open(url: &str) {
    spawn(url);
}

fn spawn(url: &str) {
    #[cfg(windows)]
    {
        let _ = Command::new("cmd").args(["/c", "start", "", url]).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
    }
}

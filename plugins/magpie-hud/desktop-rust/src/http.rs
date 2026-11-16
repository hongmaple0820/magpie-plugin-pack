// 极简 HTTP/1.1 GET：只访问本机插件服务，不值得引入 TLS/异步栈。
// 用 TcpStream 说一句话、读全部、按 \r\n\r\n 切出 body 即可。
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

/// 给设置写回用：POST JSON。返回是否 2xx。
pub fn post(port: u16, path: &str, body: &str) -> bool {
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(6)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(6)));
    let req = format!(
        "POST {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        path,
        port,
        body.len(),
        body
    );
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let Ok(n) = s.read(&mut buf) else {
        return false;
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 2") || head.starts_with("HTTP/1.0 2")
}

pub fn get(port: u16, path: &str) -> Option<String> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(8))).ok()?;
    s.set_write_timeout(Some(Duration::from_secs(8))).ok()?;
    let req = format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n", path, port);
    s.write_all(req.as_bytes()).ok()?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).ok()?;
    decode(&raw)
}

/// 从原始响应里切出 body。Node 的 http 服务没显式写 Content-Length 时
/// 一律用 chunked —— 不拆块就会把 "1a2\r\n{...}" 喂给 serde_json，全空。
fn decode(raw: &[u8]) -> Option<String> {
    let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&raw[..head_end]).to_ascii_lowercase();
    let body = &raw[head_end + 4..];
    if head.contains("transfer-encoding: chunked") {
        Some(String::from_utf8_lossy(&dechunk(body)).to_string())
    } else {
        Some(String::from_utf8_lossy(body).to_string())
    }
}

/// 按十六进制块长拆 chunked body。按字节切：块边界可能落在多字节字符中间。
fn dechunk(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut rest = body;
    loop {
        let Some(pos) = rest.windows(2).position(|w| w == b"\r\n") else { break };
        let size_text = String::from_utf8_lossy(&rest[..pos]).trim().to_string();
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        if size == 0 {
            break;
        }
        let start = pos + 2;
        let end = (start + size).min(rest.len());
        out.extend_from_slice(&rest[start..end]);
        rest = &rest[end..];
        if rest.starts_with(b"\r\n") {
            rest = &rest[2..];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{decode, dechunk};

    #[test]
    fn dechunk_joins_blocks() {
        let body = b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        assert_eq!(String::from_utf8(dechunk(body)).unwrap(), "hello world");
    }

    #[test]
    fn dechunk_handles_multibyte_split() {
        // 「鹊」是 3 个 UTF-8 字节，故意从中间切开
        let body = b"1\r\n\xe9\r\n2\r\n\xb9\x8a\r\n0\r\n\r\n";
        assert_eq!(String::from_utf8(dechunk(body)).unwrap(), "鹊");
    }

    #[test]
    fn decode_strips_chunked_and_plain_bodies() {
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"a\":1}\r\n0\r\n\r\n";
        assert_eq!(decode(chunked).unwrap(), "{\"a\":1}");
        let plain = b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\n{\"a\":1}";
        assert_eq!(decode(plain).unwrap(), "{\"a\":1}");
    }
}
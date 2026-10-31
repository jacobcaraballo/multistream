//! Streaming relay for Twitch VOD playlists and segments on a loopback port.
//!
//! The `msvod://` scheme can only answer once Rust holds the whole body, so hls.js sees no
//! first byte and no progress until a segment is fully downloaded. Slow segments then hit the
//! time-to-first-byte timeout, the bandwidth estimate (which subtracts that wait) comes out far
//! too high so the player picks a quality the link can't sustain, and abandoned downloads keep
//! running. This relay streams the CDN response as it arrives and drops the upstream request
//! as soon as the WebView closes the connection.
//!
//! URLs look like `http://127.0.0.1:<port>/<token>/<host>/<path>`; the random per-launch token
//! keeps other local pages from using the relay, and only allow-listed hosts are fetched.

use std::net::Ipv4Addr;
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::StreamExt;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::proxy::{is_allowed, upstream_url};
use super::types::http_client;

const MAX_REQUEST_HEAD: usize = 16 * 1024;
// a source-quality segment is ~10 MB; give slow links as long as hls.js' own load limit
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(120);

static BASE: OnceLock<String> = OnceLock::new();

/// `http://127.0.0.1:<port>/<token>/` once the relay is listening.
pub fn base_url() -> Option<&'static str> {
    BASE.get().map(String::as_str)
}

/// Binds the relay and starts accepting connections; playlists fall back to `msvod://` if it fails.
pub fn start() {
    let listener = match tauri::async_runtime::block_on(TcpListener::bind((Ipv4Addr::LOCALHOST, 0)))
    {
        Ok(listener) => listener,
        Err(err) => {
            log::warn!("[vod-relay] could not bind a loopback port: {}", err);
            return;
        }
    };
    let Ok(port) = listener.local_addr().map(|addr| addr.port()) else {
        return;
    };
    let token = uuid::Uuid::new_v4().simple().to_string();
    let prefix = format!("/{}", token);
    if BASE
        .set(format!("http://127.0.0.1:{}/{}/", port, token))
        .is_err()
    {
        return;
    }

    tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((socket, _)) => {
                    let prefix = prefix.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = serve(socket, &prefix).await;
                    });
                }
                Err(err) => log::warn!("[vod-relay] accept failed: {}", err),
            }
        }
    });
}

#[derive(Debug, PartialEq)]
struct RequestHead {
    method: String,
    target: String,
    range: Option<String>,
}

fn parse_head(head: &str) -> Option<RequestHead> {
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_string();
    let target = request_line.next()?.to_string();
    if !request_line.next()?.starts_with("HTTP/1.") {
        return None;
    }
    let range = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("range")
            .then(|| value.trim().to_string())
    });
    Some(RequestHead {
        method,
        target,
        range,
    })
}

async fn read_head<R: AsyncRead + Unpin>(reader: &mut R) -> Option<String> {
    let mut head = Vec::with_capacity(1024);
    let mut buf = [0u8; 1024];
    loop {
        let n = reader.read(&mut buf).await.ok()?;
        if n == 0 {
            return None;
        }
        head.extend_from_slice(&buf[..n]);
        if let Some(end) = head.windows(4).position(|w| w == b"\r\n\r\n") {
            head.truncate(end);
            return String::from_utf8(head).ok();
        }
        if head.len() > MAX_REQUEST_HEAD {
            return None;
        }
    }
}

fn response_head(status: u16, reason: &str, extra: &[(&str, String)]) -> String {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n",
        status, reason
    );
    for (name, value) in extra {
        head.push_str(&format!("{}: {}\r\n", name, value));
    }
    head.push_str("\r\n");
    head
}

async fn reply<W: AsyncWrite + Unpin>(
    writer: &mut W,
    status: u16,
    reason: &str,
) -> std::io::Result<()> {
    let head = response_head(status, reason, &[("Content-Length", "0".into())]);
    writer.write_all(head.as_bytes()).await?;
    writer.shutdown().await
}

async fn serve(socket: TcpStream, prefix: &str) -> std::io::Result<()> {
    let (mut reader, mut writer) = socket.into_split();
    let Some(head) = read_head(&mut reader).await else {
        return Ok(());
    };
    let Some(request) = parse_head(&head) else {
        return reply(&mut writer, 400, "Bad Request").await;
    };

    if request.method == "OPTIONS" {
        let head = response_head(
            204,
            "No Content",
            &[
                ("Access-Control-Allow-Methods", "GET".into()),
                ("Access-Control-Allow-Headers", "*".into()),
            ],
        );
        writer.write_all(head.as_bytes()).await?;
        return writer.shutdown().await;
    }
    if request.method != "GET" {
        return reply(&mut writer, 405, "Method Not Allowed").await;
    }
    let Some(path) = request
        .target
        .strip_prefix(prefix)
        .filter(|rest| rest.starts_with('/'))
    else {
        return reply(&mut writer, 404, "Not Found").await;
    };
    let Some((host, url)) = upstream_url(path) else {
        return reply(&mut writer, 400, "Bad Request").await;
    };
    if !is_allowed(&host) {
        return reply(&mut writer, 403, "Forbidden").await;
    }

    let mut upstream = http_client().get(&url).timeout(UPSTREAM_TIMEOUT);
    if let Some(range) = request.range {
        upstream = upstream.header(reqwest::header::RANGE, range);
    }

    // hls.js aborting a load closes the socket; returning drops the in-flight CDN request
    let client_gone = async {
        let mut buf = [0u8; 256];
        while matches!(reader.read(&mut buf).await, Ok(n) if n > 0) {}
    };
    tokio::select! {
        _ = client_gone => Ok(()),
        result = relay(upstream, &mut writer, &host) => result,
    }
}

async fn relay<W: AsyncWrite + Unpin>(
    request: reqwest::RequestBuilder,
    writer: &mut W,
    host: &str,
) -> std::io::Result<()> {
    let upstream = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            log::warn!("[vod-relay] request failed for {}: {}", host, err);
            return reply(writer, 502, "Bad Gateway").await;
        }
    };

    let status = upstream.status();
    let header = |name: reqwest::header::HeaderName| {
        upstream
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let mut extra = vec![(
        "Content-Type",
        header(reqwest::header::CONTENT_TYPE)
            .unwrap_or_else(|| "application/octet-stream".to_string()),
    )];
    if let Some(len) = upstream.content_length() {
        extra.push(("Content-Length", len.to_string()));
    }
    if let Some(range) = header(reqwest::header::CONTENT_RANGE) {
        extra.push(("Content-Range", range));
    }
    let head = response_head(
        status.as_u16(),
        status.canonical_reason().unwrap_or(""),
        &extra,
    );
    writer.write_all(head.as_bytes()).await?;

    let mut body = upstream.bytes_stream();
    while let Some(chunk) = body.next().await {
        match chunk {
            Ok(bytes) => writer.write_all(&bytes).await?,
            Err(err) => {
                // closing early makes hls.js see a short body and retry the segment
                log::warn!("[vod-relay] body read failed for {}: {}", host, err);
                break;
            }
        }
    }
    writer.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[test]
    fn should_parse_request_line_and_range_header() {
        // Arrange
        let head =
            "GET /tok/host.example.com/a/1.ts?x=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nrange: bytes=0-99";

        // Act
        let parsed = parse_head(head).unwrap();

        // Assert
        assert_eq!(
            parsed,
            RequestHead {
                method: "GET".into(),
                target: "/tok/host.example.com/a/1.ts?x=1".into(),
                range: Some("bytes=0-99".into()),
            }
        );
    }

    #[test]
    fn should_reject_malformed_request_lines() {
        // Act / Assert
        assert!(parse_head("GET /only-two-parts").is_none());
        assert!(parse_head("GET / SMTP/1.0").is_none());
        assert!(parse_head("").is_none());
    }

    #[tokio::test]
    async fn should_read_the_head_up_to_the_blank_line() {
        // Arrange
        let (mut client, mut server) = duplex(64);
        tokio::spawn(async move {
            client
                .write_all(b"GET /a HTTP/1.1\r\nHost: x\r\n\r\nleftover")
                .await
                .unwrap();
        });

        // Act
        let head = read_head(&mut server).await;

        // Assert
        assert_eq!(head.as_deref(), Some("GET /a HTTP/1.1\r\nHost: x"));
    }

    async fn request(prefix: &str, raw: &str) -> String {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let prefix = prefix.to_string();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            serve(socket, &prefix).await.unwrap();
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(raw.as_bytes()).await.unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).await.unwrap();
        response
    }

    #[tokio::test]
    async fn should_refuse_requests_without_the_launch_token() {
        // Act
        let response = request(
            "/secret",
            "GET /other/host.example.com/a.ts HTTP/1.1\r\n\r\n",
        )
        .await;

        // Assert
        assert!(response.starts_with("HTTP/1.1 404"), "{}", response);
    }

    #[tokio::test]
    async fn should_refuse_hosts_that_no_playlist_listed() {
        // Act
        let response = request(
            "/secret",
            "GET /secret/not-listed.example.com/a.ts HTTP/1.1\r\n\r\n",
        )
        .await;

        // Assert
        assert!(response.starts_with("HTTP/1.1 403"), "{}", response);
        assert!(response.contains("Access-Control-Allow-Origin: *"));
    }

    #[tokio::test]
    async fn should_answer_cors_preflight() {
        // Act
        let response = request(
            "/secret",
            "OPTIONS /secret/x.example.com/a.ts HTTP/1.1\r\n\r\n",
        )
        .await;

        // Assert
        assert!(response.starts_with("HTTP/1.1 204"), "{}", response);
        assert!(response.contains("Access-Control-Allow-Methods: GET"));
    }
}

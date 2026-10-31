//! Twitch's VOD CDN only sends CORS headers for twitch.tv origins, so hls.js running
//! inside the WebView cannot fetch playlists or segments directly. This custom URI
//! scheme relays GET requests to the CDN and adds a permissive CORS header.
//!
//! URLs are path-encoded (`msvod://localhost/<host>/<path>`) rather than query-encoded so
//! that relative segment URIs inside variant playlists resolve back through the proxy.
//! Only hosts that appeared in a playlist returned by Twitch's usher are relayed.
//! Playlists point at the streaming relay (`stream_proxy`) when it is running; this scheme is
//! the fallback.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use tauri::http::{header, Method, Request, Response, StatusCode};

use super::types::http_client;

pub const SCHEME: &str = "msvod";

fn allowed_hosts() -> &'static Mutex<HashSet<String>> {
    static HOSTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    HOSTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.contains('.')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

pub(crate) fn is_allowed(host: &str) -> bool {
    allowed_hosts()
        .lock()
        .map(|hosts| hosts.contains(host))
        .unwrap_or(false)
}

fn proxy_base() -> &'static str {
    // the streaming relay when it's up; the scheme only answers once a whole segment arrived
    if let Some(base) = super::stream_proxy::base_url() {
        return base;
    }
    // WebView2 and Android expose custom schemes as http://<scheme>.localhost
    if cfg!(any(windows, target_os = "android")) {
        "http://msvod.localhost/"
    } else {
        "msvod://localhost/"
    }
}

/// Converts `https://host/path?query` into a proxied URL and allow-lists `host`.
pub fn to_proxy_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let host = rest.split(['/', '?']).next()?.to_ascii_lowercase();
    if !is_valid_host(&host) {
        return None;
    }
    if let Ok(mut hosts) = allowed_hosts().lock() {
        hosts.insert(host.clone());
    }
    Some(format!(
        "{}{}{}",
        proxy_base(),
        host,
        &rest[rest.find(['/', '?']).unwrap_or(rest.len())..]
    ))
}

/// Reverses [`to_proxy_url`] for an incoming request path: `/host/path?query` → (`host`, `https://host/path?query`).
pub(crate) fn upstream_url(path_and_query: &str) -> Option<(String, String)> {
    let rest = path_and_query.strip_prefix('/')?;
    let split_at = rest.find(['/', '?']).unwrap_or(rest.len());
    let host = rest[..split_at].to_ascii_lowercase();
    if !is_valid_host(&host) {
        return None;
    }
    let tail = &rest[split_at..];
    if tail.contains("..") {
        return None;
    }
    Some((host.clone(), format!("https://{}{}", host, tail)))
}

/// Rewrites every absolute variant/rendition URI in a master playlist to go through the proxy.
pub fn rewrite_master_playlist(m3u8: &str) -> String {
    m3u8.lines()
        .map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with("https://") {
                return to_proxy_url(trimmed).unwrap_or_else(|| line.to_string());
            }
            if let Some(start) = line.find("URI=\"https://") {
                let uri_start = start + 5;
                if let Some(len) = line[uri_start..].find('"') {
                    let uri = &line[uri_start..uri_start + len];
                    if let Some(proxied) = to_proxy_url(uri) {
                        return format!(
                            "{}{}{}",
                            &line[..uri_start],
                            proxied,
                            &line[uri_start + len..]
                        );
                    }
                }
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn respond(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub async fn handle(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() == Method::OPTIONS {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }
    if request.method() != Method::GET {
        return respond(StatusCode::METHOD_NOT_ALLOWED, "text/plain", Vec::new());
    }

    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let Some((host, url)) = upstream_url(path_and_query) else {
        return respond(StatusCode::BAD_REQUEST, "text/plain", Vec::new());
    };
    if !is_allowed(&host) {
        return respond(StatusCode::FORBIDDEN, "text/plain", Vec::new());
    }

    let upstream = match http_client().get(&url).send().await {
        Ok(resp) => resp,
        Err(err) => {
            log::warn!("[vod-proxy] request failed for {}: {}", host, err);
            return respond(StatusCode::BAD_GATEWAY, "text/plain", Vec::new());
        }
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    match upstream.bytes().await {
        Ok(body) => respond(status, &content_type, body.to_vec()),
        Err(err) => {
            log::warn!("[vod-proxy] body read failed for {}: {}", host, err);
            respond(StatusCode::BAD_GATEWAY, "text/plain", Vec::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_round_trip_proxy_urls() {
        // Arrange
        let original = "https://d3stzm2eumvgb4.cloudfront.net/abc_ibai_1/720p30/index-dvr.m3u8";

        // Act
        let proxied = to_proxy_url(original).unwrap();
        let path = proxied.strip_prefix(proxy_base()).unwrap();
        let (host, upstream) = upstream_url(&format!("/{}", path)).unwrap();

        // Assert
        assert_eq!(host, "d3stzm2eumvgb4.cloudfront.net");
        assert_eq!(upstream, original);
        assert!(is_allowed("d3stzm2eumvgb4.cloudfront.net"));
    }

    #[test]
    fn should_resolve_relative_segment_paths_to_the_same_host() {
        // Arrange
        let segment_path = "/d3stzm2eumvgb4.cloudfront.net/abc_ibai_1/720p30/12-muted.ts";

        // Act
        let (host, upstream) = upstream_url(segment_path).unwrap();

        // Assert
        assert_eq!(host, "d3stzm2eumvgb4.cloudfront.net");
        assert_eq!(
            upstream,
            "https://d3stzm2eumvgb4.cloudfront.net/abc_ibai_1/720p30/12-muted.ts"
        );
    }

    #[test]
    fn should_reject_non_https_and_malformed_hosts() {
        // Arrange / Act / Assert
        assert!(to_proxy_url("http://example.com/a.m3u8").is_none());
        assert!(to_proxy_url("https:///a.m3u8").is_none());
        assert!(upstream_url("/localhost/a.ts").is_none());
        assert!(upstream_url("/evil.com/../a.ts").is_none());
        assert!(upstream_url("/user@evil.com/a.ts").is_none());
    }

    #[test]
    fn should_not_allow_hosts_that_were_never_registered() {
        // Arrange / Act / Assert
        assert!(!is_allowed("never-registered.example.com"));
    }

    #[test]
    fn should_rewrite_master_playlist_variants_only() {
        // Arrange
        let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://cdn.example.net/x/720p30/index-dvr.m3u8\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"https://cdn.example.net/x/audio/index-dvr.m3u8\"";

        // Act
        let rewritten = rewrite_master_playlist(master);

        // Assert
        let base = proxy_base();
        assert!(rewritten.starts_with("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n"));
        assert!(rewritten.contains(&format!("{}cdn.example.net/x/720p30/index-dvr.m3u8", base)));
        assert!(rewritten.contains(&format!(
            "URI=\"{}cdn.example.net/x/audio/index-dvr.m3u8\"",
            base
        )));
        assert!(!rewritten.contains("https://"));
    }
}

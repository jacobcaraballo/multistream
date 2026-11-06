use std::sync::OnceLock;
use std::time::Duration;

use chrono::{DateTime, NaiveDateTime};
use serde::{Deserialize, Serialize};

// realistic Chrome user-agent; Kick sits behind Cloudflare
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Vod {
    pub id: String,
    pub platform: String,
    pub channel: String,
    pub display_name: String,
    pub title: String,
    /// Broadcast start as epoch milliseconds (UTC).
    pub started_at: i64,
    pub duration_seconds: u64,
    pub is_recording: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_count: Option<u64>,
}

/// A stretch of a VOD spent on one game (Twitch "chapters").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VodChapter {
    pub start_s: f64,
    /// None while the chapter is still running on a live recording.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_s: Option<f64>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VodPage {
    pub vods: Vec<Vod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

pub fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .use_rustls_tls()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .expect("Failed to build VOD HTTP client with rustls-tls")
    })
}

/// Accepts RFC 3339 (`2026-10-30T19:25:36Z`) and Kick's naive UTC format (`2026-10-30 19:22:52`).
pub fn parse_timestamp_ms(value: &str) -> Option<i64> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(value) {
        return Some(dt.timestamp_millis());
    }
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|dt| dt.and_utc().timestamp_millis())
}

pub fn is_valid_channel(channel: &str) -> bool {
    !channel.is_empty()
        && channel.len() <= 64
        && channel
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_parse_rfc3339_and_naive_timestamps() {
        // Arrange
        let rfc = "2026-10-30T19:25:36Z";
        let offset = "2026-10-30T19:22:52+00:00";
        let naive = "2026-10-30 19:22:52";

        // Act
        let rfc_ms = parse_timestamp_ms(rfc);
        let offset_ms = parse_timestamp_ms(offset);
        let naive_ms = parse_timestamp_ms(naive);

        // Assert
        assert_eq!(rfc_ms, Some(1_793_388_336_000));
        assert_eq!(offset_ms, naive_ms);
        assert!(naive_ms.is_some());
    }

    #[test]
    fn should_reject_garbage_timestamps() {
        // Arrange / Act / Assert
        assert_eq!(parse_timestamp_ms(""), None);
        assert_eq!(parse_timestamp_ms("yesterday"), None);
    }

    #[test]
    fn should_validate_channel_names() {
        // Arrange / Act / Assert
        assert!(is_valid_channel("ibai"));
        assert!(is_valid_channel("some-kick_user1"));
        assert!(!is_valid_channel(""));
        assert!(!is_valid_channel("../etc"));
        assert!(!is_valid_channel("name with space"));
    }

    #[test]
    fn should_serialize_vod_as_camel_case() {
        // Arrange
        let vod = Vod {
            id: "1".into(),
            platform: "twitch".into(),
            channel: "ibai".into(),
            display_name: "Ibai".into(),
            title: "t".into(),
            started_at: 1,
            duration_seconds: 2,
            is_recording: true,
            thumbnail_url: None,
            category: None,
            view_count: None,
        };

        // Act
        let json = serde_json::to_string(&vod).unwrap();

        // Assert
        assert!(json.contains(r#""startedAt":1"#));
        assert!(json.contains(r#""durationSeconds":2"#));
        assert!(json.contains(r#""isRecording":true"#));
        assert!(!json.contains("thumbnailUrl"));
    }
}

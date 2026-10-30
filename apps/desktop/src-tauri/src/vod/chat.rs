//! Chat replay for past broadcasts. Messages are shaped like the live `UnifiedChatMessage`
//! so the existing chat renderer can display them, plus `offset_seconds`: how far into the
//! VOD the message appears, which the frontend compares with the player's media time.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};

use super::error::VodError;
use super::types::{http_client, is_valid_channel, parse_timestamp_ms};
use crate::twitch::web_session::{GQL_URL, WEB_CLIENT_ID};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct VodChatMessage {
    pub id: String,
    pub channel: String,
    pub username: String,
    pub display_name: String,
    pub message: String,
    pub timestamp_ms: i64,
    pub offset_seconds: f64,
    pub color: Option<String>,
    pub badges: Vec<String>,
    pub emotes: Option<String>,
    pub platform: String,
}

/// Twitch emote ranges in the `id:start-end/...` IRC format, as UTF-16 offsets because the
/// frontend renderer slices message text with `String.prototype.substring`.
pub(crate) fn twitch_message_and_emotes(fragments: &[Value]) -> (String, Option<String>) {
    let mut text = String::new();
    let mut ranges: Vec<(String, usize, usize)> = Vec::new();
    let mut cursor = 0usize;

    for fragment in fragments {
        let part = fragment["text"].as_str().unwrap_or_default();
        let len = part.encode_utf16().count();
        if let Some(id) = fragment["emote"]["emoteID"].as_str() {
            if len > 0 {
                ranges.push((id.to_string(), cursor, cursor + len - 1));
            }
        }
        text.push_str(part);
        cursor += len;
    }

    if ranges.is_empty() {
        return (text, None);
    }

    let mut grouped: Vec<(String, Vec<String>)> = Vec::new();
    for (id, start, end) in ranges {
        let span = format!("{}-{}", start, end);
        match grouped.iter_mut().find(|(existing, _)| *existing == id) {
            Some((_, spans)) => spans.push(span),
            None => grouped.push((id, vec![span])),
        }
    }
    let emotes = grouped
        .into_iter()
        .map(|(id, spans)| format!("{}:{}", id, spans.join(",")))
        .collect::<Vec<_>>()
        .join("/");
    (text, Some(emotes))
}

pub(crate) fn parse_twitch_comments(body: &Value, channel: &str) -> Vec<VodChatMessage> {
    let edges = body["data"]["video"]["comments"]["edges"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    edges
        .iter()
        .filter_map(|edge| {
            let node = &edge["node"];
            let id = node["id"].as_str()?.to_string();
            let commenter = &node["commenter"];
            let username = commenter["login"].as_str()?.to_string();
            let fragments = node["message"]["fragments"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let (message, emotes) = twitch_message_and_emotes(&fragments);
            let badges = node["message"]["userBadges"]
                .as_array()
                .map(|badges| {
                    badges
                        .iter()
                        .filter_map(|b| {
                            let set = b["setID"].as_str()?;
                            Some(format!("{}/{}", set, b["version"].as_str().unwrap_or("1")))
                        })
                        .collect()
                })
                .unwrap_or_default();

            Some(VodChatMessage {
                id,
                channel: channel.to_string(),
                display_name: commenter["displayName"]
                    .as_str()
                    .unwrap_or(&username)
                    .to_string(),
                username,
                message,
                timestamp_ms: node["createdAt"]
                    .as_str()
                    .and_then(parse_timestamp_ms)
                    .unwrap_or_default(),
                offset_seconds: node["contentOffsetSeconds"].as_f64().unwrap_or_default(),
                color: node["message"]["userColor"]
                    .as_str()
                    .filter(|c| !c.is_empty())
                    .map(str::to_string),
                badges,
                emotes,
                platform: "twitch".into(),
            })
        })
        .collect()
}

pub(crate) fn parse_kick_messages(
    body: &Value,
    channel: &str,
    started_at_ms: i64,
) -> Vec<VodChatMessage> {
    let messages = body["data"]["messages"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    messages
        .iter()
        .filter_map(|m| {
            let id = m["id"].as_str()?.to_string();
            let sender = &m["sender"];
            let display_name = sender["username"].as_str()?.to_string();
            let timestamp_ms = m["created_at"].as_str().and_then(parse_timestamp_ms)?;
            let badges = sender["identity"]["badges"]
                .as_array()
                .map(|badges| {
                    badges
                        .iter()
                        .filter_map(|b| b["type"].as_str().map(|t| format!("{}/1", t)))
                        .collect()
                })
                .unwrap_or_default();

            Some(VodChatMessage {
                id,
                channel: channel.to_string(),
                username: sender["slug"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| display_name.to_lowercase()),
                display_name,
                message: m["content"].as_str().unwrap_or_default().to_string(),
                timestamp_ms,
                offset_seconds: (timestamp_ms - started_at_ms) as f64 / 1000.0,
                color: sender["identity"]["color"]
                    .as_str()
                    .filter(|c| !c.is_empty())
                    .map(str::to_string),
                badges,
                emotes: None,
                platform: "kick".into(),
            })
        })
        .collect()
}

async fn twitch_chat(
    vod_id: &str,
    channel: &str,
    offset_seconds: u64,
) -> Result<Vec<VodChatMessage>, VodError> {
    if !super::twitch::is_valid_vod_id(vod_id) {
        return Err(VodError::Validation("Invalid Twitch VOD id".into()));
    }

    // Only offset lookups pass anonymously; cursor pagination fails Twitch's integrity check,
    // so the frontend pages by asking again from the last offset it received.
    let res = http_client()
        .post(GQL_URL)
        .header("Client-ID", WEB_CLIENT_ID)
        .json(&json!({
            "query": "query($id: ID!, $offset: Int) { video(id: $id) { comments(contentOffsetSeconds: $offset) { edges { node { id contentOffsetSeconds createdAt commenter { login displayName } message { fragments { text emote { emoteID } } userBadges { setID version } userColor } } } } } }",
            "variables": { "id": vod_id, "offset": offset_seconds }
        }))
        .send()
        .await?;

    if !res.status().is_success() {
        return Err(VodError::Api(format!("Twitch GQL HTTP {}", res.status())));
    }
    let body: Value = res.json().await?;
    if let Some(msg) = body["errors"]
        .as_array()
        .and_then(|e| e.first())
        .and_then(|e| e["message"].as_str())
    {
        return Err(VodError::Api(format!("Twitch GQL: {}", msg)));
    }
    Ok(parse_twitch_comments(&body, channel))
}

fn kick_channel_ids() -> &'static Mutex<HashMap<String, u64>> {
    static IDS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    IDS.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn kick_channel_id(slug: &str) -> Result<u64, VodError> {
    if let Some(id) = kick_channel_ids()
        .lock()
        .ok()
        .and_then(|ids| ids.get(slug).copied())
    {
        return Ok(id);
    }

    let res = http_client()
        .get(format!("https://kick.com/api/v2/channels/{}", slug))
        .header("Accept", "application/json")
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(VodError::NotFound("Kick channel".into()));
    }
    let body: Value = res.json().await?;
    let id = body["id"]
        .as_u64()
        .ok_or_else(|| VodError::NotFound("Kick channel".into()))?;
    if let Ok(mut ids) = kick_channel_ids().lock() {
        ids.insert(slug.to_string(), id);
    }
    Ok(id)
}

fn kick_start_time(started_at_ms: i64, offset_seconds: u64) -> Option<String> {
    let ms = started_at_ms.checked_add((offset_seconds as i64).checked_mul(1000)?)?;
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// Kick serves chat history in short windows (about five seconds) starting at `start_time`.
async fn kick_chat(
    channel: &str,
    started_at_ms: i64,
    offset_seconds: u64,
) -> Result<Vec<VodChatMessage>, VodError> {
    let slug = channel.to_lowercase();
    if !is_valid_channel(&slug) {
        return Err(VodError::Validation("Invalid channel name".into()));
    }
    let start = kick_start_time(started_at_ms, offset_seconds)
        .ok_or_else(|| VodError::Validation("Invalid start time".into()))?;
    let channel_id = kick_channel_id(&slug).await?;

    let res = http_client()
        .get(format!(
            "https://kick.com/api/v2/channels/{}/messages",
            channel_id
        ))
        .query(&[("start_time", start)])
        .header("Accept", "application/json")
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(VodError::Api(format!("Kick HTTP {}", res.status())));
    }
    Ok(parse_kick_messages(
        &res.json().await?,
        &slug,
        started_at_ms,
    ))
}

#[tauri::command]
pub async fn vod_chat(
    platform: String,
    vod_id: String,
    channel: String,
    started_at: i64,
    offset_seconds: u64,
) -> Result<Vec<VodChatMessage>, VodError> {
    match platform.as_str() {
        "twitch" => twitch_chat(&vod_id, &channel.to_lowercase(), offset_seconds).await,
        "kick" => kick_chat(&channel, started_at, offset_seconds).await,
        other => Err(VodError::Validation(format!(
            "VOD chat is not supported for platform '{}'",
            other
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_build_irc_style_emote_ranges_in_utf16_units() {
        // Arrange
        let fragments = vec![
            json!({ "text": "hi 😀 ", "emote": null }),
            json!({ "text": "Kappa", "emote": { "emoteID": "25" } }),
            json!({ "text": " and ", "emote": null }),
            json!({ "text": "Kappa", "emote": { "emoteID": "25" } }),
            json!({ "text": " ", "emote": null }),
            json!({ "text": "LUL", "emote": { "emoteID": "425618" } }),
        ];

        // Act
        let (text, emotes) = twitch_message_and_emotes(&fragments);

        // Assert
        assert_eq!(text, "hi 😀 Kappa and Kappa LUL");
        // "hi 😀 " is 6 UTF-16 units (the emoji is a surrogate pair)
        assert_eq!(emotes.as_deref(), Some("25:6-10,16-20/425618:22-24"));
    }

    #[test]
    fn should_leave_emotes_empty_for_plain_text() {
        // Arrange
        let fragments = vec![json!({ "text": "just text", "emote": null })];

        // Act
        let (text, emotes) = twitch_message_and_emotes(&fragments);

        // Assert
        assert_eq!(text, "just text");
        assert!(emotes.is_none());
    }

    #[test]
    fn should_parse_twitch_comments_into_chat_messages() {
        // Arrange
        let body = json!({ "data": { "video": { "comments": { "edges": [
            { "node": {
                "id": "c1", "contentOffsetSeconds": 3579, "createdAt": "2026-10-30T19:59:44.52Z",
                "commenter": { "login": "lovelypleb", "displayName": "LovelyPleb" },
                "message": {
                    "fragments": [{ "text": "PepeLaugh", "emote": null }],
                    "userBadges": [{ "setID": "subscriber", "version": "12" }],
                    "userColor": "#B22222"
                }
            }},
            { "node": { "id": "deleted-user", "commenter": null, "message": {} } }
        ]}}}});

        // Act
        let messages = parse_twitch_comments(&body, "riotgames");

        // Assert
        assert_eq!(messages.len(), 1);
        let m = &messages[0];
        assert_eq!(m.channel, "riotgames");
        assert_eq!(m.username, "lovelypleb");
        assert_eq!(m.display_name, "LovelyPleb");
        assert_eq!(m.offset_seconds, 3579.0);
        assert_eq!(m.badges, vec!["subscriber/12".to_string()]);
        assert_eq!(m.color.as_deref(), Some("#B22222"));
        assert_eq!(m.platform, "twitch");
        assert!(m.timestamp_ms > 0);
    }

    #[test]
    fn should_parse_kick_messages_with_offsets_from_vod_start() {
        // Arrange
        let started = parse_timestamp_ms("2026-10-30T19:22:52Z").unwrap();
        let body = json!({ "data": { "messages": [{
            "id": "k1",
            "content": "[emote:5748003:collectiblesGoldenLULW] lol",
            "created_at": "2026-10-30T20:00:00Z",
            "sender": {
                "slug": "getmoneya", "username": "GetmoneyA",
                "identity": { "color": "#FF9D00", "badges": [{ "type": "subscriber", "text": "Sub", "count": 3 }] }
            }
        }]}});

        // Act
        let messages = parse_kick_messages(&body, "xqc", started);

        // Assert
        assert_eq!(messages.len(), 1);
        let m = &messages[0];
        assert_eq!(m.username, "getmoneya");
        assert_eq!(m.display_name, "GetmoneyA");
        assert_eq!(m.offset_seconds, 2228.0);
        assert_eq!(m.badges, vec!["subscriber/1".to_string()]);
        assert_eq!(m.message, "[emote:5748003:collectiblesGoldenLULW] lol");
        assert!(m.emotes.is_none());
        assert_eq!(m.platform, "kick");
    }

    #[test]
    fn should_format_kick_start_times_in_utc_millis() {
        // Arrange
        let started = parse_timestamp_ms("2026-10-30T19:22:52Z").unwrap();

        // Act
        let start = kick_start_time(started, 2228);

        // Assert
        assert_eq!(start.as_deref(), Some("2026-10-30T20:00:00.000Z"));
    }

    #[test]
    fn should_serialize_with_the_live_chat_field_names() {
        // Arrange
        let body = json!({ "data": { "video": { "comments": { "edges": [{ "node": {
            "id": "c1", "contentOffsetSeconds": 1, "createdAt": "2026-10-30T19:59:44Z",
            "commenter": { "login": "a", "displayName": "A" },
            "message": { "fragments": [{ "text": "x" }], "userBadges": [], "userColor": "" }
        }}]}}}});

        // Act
        let json = serde_json::to_string(&parse_twitch_comments(&body, "ch")[0]).unwrap();

        // Assert
        assert!(json.contains(r#""display_name":"A""#));
        assert!(json.contains(r#""timestamp_ms":"#));
        assert!(json.contains(r#""offset_seconds":1.0"#));
        assert!(json.contains(r#""color":null"#));
    }
}

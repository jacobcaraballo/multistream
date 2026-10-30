use serde_json::Value;

use super::error::VodError;
use super::types::{http_client, is_valid_channel, parse_timestamp_ms, Vod};

pub fn is_valid_vod_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Parses a Kick `livestream` object. The list endpoint nests the video under `video`
/// and exposes `thumbnail.src`; the single-video endpoint inverts that and uses a plain string.
pub(crate) fn parse_livestream(
    livestream: &Value,
    uuid: &str,
    channel: &str,
    display_name: &str,
    view_count: Option<u64>,
    now_ms: i64,
) -> Option<Vod> {
    let started_at = livestream["start_time"]
        .as_str()
        .or_else(|| livestream["created_at"].as_str())
        .and_then(parse_timestamp_ms)?;
    let is_recording = livestream["is_live"].as_bool().unwrap_or(false);
    let duration_seconds = match livestream["duration"].as_u64() {
        Some(ms) if ms > 0 => ms / 1000,
        _ if is_recording => ((now_ms - started_at).max(0) / 1000) as u64,
        _ => 0,
    };
    let thumbnail_url = livestream["thumbnail"]["src"]
        .as_str()
        .or_else(|| livestream["thumbnail"].as_str())
        .filter(|url| !url.is_empty())
        .map(str::to_string);

    Some(Vod {
        id: uuid.to_string(),
        platform: "kick".into(),
        channel: channel.to_string(),
        display_name: display_name.to_string(),
        title: livestream["session_title"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        started_at,
        duration_seconds,
        is_recording,
        thumbnail_url,
        category: livestream["categories"][0]["name"]
            .as_str()
            .map(str::to_string),
        view_count,
    })
}

pub(crate) fn parse_channel_videos(body: &Value, channel: &str, now_ms: i64) -> Vec<Vod> {
    body.as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let uuid = item["video"]["uuid"].as_str()?;
                    let views = item["video"]["views"].as_u64().or(item["views"].as_u64());
                    parse_livestream(item, uuid, channel, channel, views, now_ms)
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn parse_video(body: &Value, now_ms: i64) -> Option<(Vod, Option<String>)> {
    let uuid = body["uuid"].as_str()?;
    let livestream = &body["livestream"];
    let channel = livestream["channel"]["slug"].as_str()?;
    let display_name = livestream["channel"]["user"]["username"]
        .as_str()
        .unwrap_or(channel);
    let vod = parse_livestream(
        livestream,
        uuid,
        channel,
        display_name,
        body["views"].as_u64(),
        now_ms,
    )?;
    let source = body["source"].as_str().map(str::to_string);
    Some((vod, source))
}

async fn get_json(url: &str) -> Result<Value, VodError> {
    let res = http_client()
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await?;
    match res.status().as_u16() {
        404 => Err(VodError::NotFound("Kick resource".into())),
        s if !(200..300).contains(&s) => Err(VodError::Api(format!("Kick HTTP {}", s))),
        _ => Ok(res.json().await?),
    }
}

pub async fn list_vods(channel: &str) -> Result<Vec<Vod>, VodError> {
    let slug = channel.to_lowercase();
    if !is_valid_channel(&slug) {
        return Err(VodError::Validation("Invalid channel name".into()));
    }
    let body = get_json(&format!("https://kick.com/api/v2/channels/{}/videos", slug)).await?;
    Ok(parse_channel_videos(
        &body,
        &slug,
        chrono::Utc::now().timestamp_millis(),
    ))
}

async fn fetch_video(id: &str) -> Result<(Vod, Option<String>), VodError> {
    if !is_valid_vod_id(id) {
        return Err(VodError::Validation("Invalid Kick VOD id".into()));
    }
    let body = get_json(&format!("https://kick.com/api/v1/video/{}", id)).await?;
    parse_video(&body, chrono::Utc::now().timestamp_millis())
        .ok_or_else(|| VodError::NotFound("Kick VOD".into()))
}

pub async fn get_vod(id: &str) -> Result<Vod, VodError> {
    fetch_video(id).await.map(|(vod, _)| vod)
}

/// Kick's CDN already allows any origin, so the source playlist is returned as-is.
pub async fn get_playback_url(id: &str) -> Result<String, VodError> {
    fetch_video(id)
        .await?
        .1
        .filter(|url| url.starts_with("https://"))
        .ok_or_else(|| VodError::NotFound("Kick VOD source".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_793_394_000_000;

    fn list_item(is_live: bool, duration: u64) -> Value {
        json!({
            "start_time": "2026-10-30 19:22:52",
            "created_at": "2026-10-30 19:22:55",
            "session_title": "GTA",
            "is_live": is_live,
            "duration": duration,
            "thumbnail": { "src": "https://images.kick.com/t/720.webp" },
            "categories": [{ "name": "GTA V" }],
            "views": 10,
            "video": { "uuid": "6c2265bd-60c0-4903-9f78-af76c989a41a", "views": 54335 }
        })
    }

    #[test]
    fn should_parse_finished_list_item_with_ms_duration() {
        // Arrange
        let body = json!([list_item(false, 50_381_000)]);

        // Act
        let vods = parse_channel_videos(&body, "xqc", NOW);

        // Assert
        assert_eq!(vods.len(), 1);
        let vod = &vods[0];
        assert_eq!(vod.id, "6c2265bd-60c0-4903-9f78-af76c989a41a");
        assert_eq!(vod.platform, "kick");
        assert_eq!(vod.duration_seconds, 50_381);
        assert!(!vod.is_recording);
        assert_eq!(vod.view_count, Some(54_335));
        assert_eq!(vod.category.as_deref(), Some("GTA V"));
        assert_eq!(
            vod.thumbnail_url.as_deref(),
            Some("https://images.kick.com/t/720.webp")
        );
    }

    #[test]
    fn should_estimate_duration_for_live_vods_from_start_time() {
        // Arrange
        let body = json!([list_item(true, 0)]);

        // Act
        let vod = parse_channel_videos(&body, "xqc", NOW).remove(0);

        // Assert
        assert!(vod.is_recording);
        assert_eq!(
            vod.duration_seconds as i64,
            (NOW - parse_timestamp_ms("2026-10-30 19:22:52").unwrap()) / 1000
        );
    }

    #[test]
    fn should_skip_list_items_without_video_uuid() {
        // Arrange
        let mut item = list_item(false, 1000);
        item["video"] = Value::Null;

        // Act
        let vods = parse_channel_videos(&json!([item]), "xqc", NOW);

        // Assert
        assert!(vods.is_empty());
    }

    #[test]
    fn should_parse_single_video_with_string_thumbnail_and_source() {
        // Arrange
        let body = json!({
            "uuid": "6c3676a7-b79a-497b-bbed-a065c16606d1",
            "views": 54335,
            "source": "https://stream.kick.com/x/master.m3u8",
            "livestream": {
                "start_time": "2026-10-29T20:07:16+00:00",
                "session_title": "t",
                "is_live": false,
                "duration": 50_381_000,
                "thumbnail": "https://kick-prod.s3.amazonaws.com/thumb0.jpg",
                "categories": [],
                "channel": { "slug": "xqc", "user": { "username": "xQc" } }
            }
        });

        // Act
        let (vod, source) = parse_video(&body, NOW).unwrap();

        // Assert
        assert_eq!(vod.channel, "xqc");
        assert_eq!(vod.display_name, "xQc");
        assert_eq!(
            vod.thumbnail_url.as_deref(),
            Some("https://kick-prod.s3.amazonaws.com/thumb0.jpg")
        );
        assert!(vod.category.is_none());
        assert_eq!(
            source.as_deref(),
            Some("https://stream.kick.com/x/master.m3u8")
        );
    }

    #[test]
    fn should_validate_kick_vod_ids() {
        // Arrange / Act / Assert
        assert!(is_valid_vod_id("6c3676a7-b79a-497b-bbed-a065c16606d1"));
        assert!(!is_valid_vod_id("6c3676a7"));
        assert!(!is_valid_vod_id("../../../../../../../../etc/passwd/aaaaa"));
    }
}

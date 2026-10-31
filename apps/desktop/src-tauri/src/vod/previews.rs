//! Seek-bar preview thumbnails.
//!
//! Twitch publishes a storyboard (grid sprite sheets) for finished VODs. Kick records on AWS IVS,
//! which writes one full frame every 60 seconds, also while the broadcast is still recording.

use serde::Serialize;
use serde_json::Value;

const KICK_PLAYLIST_SUFFIX: &str = "media/hls/master.m3u8";
const KICK_FRAMES_PATH: &str = "media/thumbnails/thumb";
const KICK_FRAME_INTERVAL_S: u64 = 60;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VodPreviews {
    /// Tile `i` shows media second `i * interval`; tiles fill each image row by row.
    #[serde(rename_all = "camelCase")]
    Sprites {
        interval: f64,
        count: u32,
        cols: u32,
        rows: u32,
        width: u32,
        height: u32,
        images: Vec<String>,
    },
    /// Frame `n` (from `first`) shows media second `n * interval`, at `{url_prefix}{n}.jpg`.
    #[serde(rename_all = "camelCase")]
    Frames {
        url_prefix: String,
        interval: u64,
        first: u64,
        /// Last frame of a finished VOD; recordings keep adding frames.
        #[serde(skip_serializing_if = "Option::is_none")]
        last: Option<u64>,
    },
}

fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Parses a Twitch storyboard info file (`…/storyboards/<id>-info.json`), preferring the sharper
/// "high" sprites. Image names are relative to the info file's folder.
pub fn parse_storyboard(info_url: &str, body: &[u8]) -> Option<VodPreviews> {
    let base = &info_url[..=info_url.rfind('/')?];
    let boards: Vec<Value> = serde_json::from_slice(body).ok()?;
    let board = boards
        .iter()
        .find(|b| b["quality"] == "high")
        .or_else(|| boards.first())?;

    let field = |key: &str| board[key].as_u64().and_then(|v| u32::try_from(v).ok());
    let (count, cols, rows, width, height) = (
        field("count")?,
        field("cols")?,
        field("rows")?,
        field("width")?,
        field("height")?,
    );
    let interval = board["interval"].as_f64().filter(|i| *i > 0.0)?;
    let images = board["images"]
        .as_array()?
        .iter()
        .map(|name| name.as_str().filter(|n| is_safe_file_name(n)))
        .collect::<Option<Vec<_>>>()?
        .into_iter()
        .map(|name| format!("{}{}", base, name))
        .collect::<Vec<_>>();

    if count == 0 || cols == 0 || rows == 0 || width == 0 || height == 0 || images.is_empty() {
        return None;
    }
    Some(VodPreviews::Sprites {
        interval,
        count,
        cols,
        rows,
        width,
        height,
        images,
    })
}

/// Derives the frame series from a Kick VOD's IVS playlist URL (`…/<recording>/media/hls/master.m3u8`).
pub fn kick_frames(source: &str, duration_s: u64, is_recording: bool) -> Option<VodPreviews> {
    if !source.starts_with("https://") {
        return None;
    }
    let folder = source.strip_suffix(KICK_PLAYLIST_SUFFIX)?;
    Some(VodPreviews::Frames {
        url_prefix: format!("{}{}", folder, KICK_FRAMES_PATH),
        interval: KICK_FRAME_INTERVAL_S,
        first: 1,
        last: (!is_recording).then(|| (duration_s / KICK_FRAME_INTERVAL_S).max(1)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const INFO_URL: &str =
        "https://d3stzm2eumvgb4.cloudfront.net/abc_123/storyboards/2913962001-info.json";

    #[test]
    fn should_prefer_the_high_quality_storyboard_and_resolve_image_urls() {
        // Arrange
        let body = br#"[
            {"count":200,"width":160,"height":90,"rows":40,"cols":5,"images":["2913962001-low-0.jpg"],"interval":186,"quality":"low"},
            {"count":200,"width":220,"height":124,"rows":10,"cols":5,"images":["2913962001-high-0.jpg","2913962001-high-1.jpg"],"interval":186,"quality":"high"}
        ]"#;

        // Act
        let previews = parse_storyboard(INFO_URL, body);

        // Assert
        assert_eq!(
            previews,
            Some(VodPreviews::Sprites {
                interval: 186.0,
                count: 200,
                cols: 5,
                rows: 10,
                width: 220,
                height: 124,
                images: vec![
                    "https://d3stzm2eumvgb4.cloudfront.net/abc_123/storyboards/2913962001-high-0.jpg"
                        .into(),
                    "https://d3stzm2eumvgb4.cloudfront.net/abc_123/storyboards/2913962001-high-1.jpg"
                        .into(),
                ],
            })
        );
    }

    #[test]
    fn should_fall_back_to_the_only_storyboard() {
        // Arrange
        let body = br#"[{"count":3,"width":110,"height":62,"rows":1,"cols":5,"images":["9-low-0.jpg"],"interval":4,"quality":"low"}]"#;

        // Act
        let previews = parse_storyboard(INFO_URL, body);

        // Assert
        assert!(matches!(
            previews,
            Some(VodPreviews::Sprites {
                count: 3,
                width: 110,
                ..
            })
        ));
    }

    #[test]
    fn should_reject_storyboards_with_unsafe_or_missing_fields() {
        // Arrange
        let traversal = br#"[{"count":1,"width":1,"height":1,"rows":1,"cols":1,"images":["../x.jpg"],"interval":4,"quality":"low"}]"#;
        let nested = br#"[{"count":1,"width":1,"height":1,"rows":1,"cols":1,"images":["a/x.jpg"],"interval":4,"quality":"low"}]"#;
        let no_interval = br#"[{"count":1,"width":1,"height":1,"rows":1,"cols":1,"images":["x.jpg"],"interval":0,"quality":"low"}]"#;

        // Act / Assert
        assert_eq!(parse_storyboard(INFO_URL, traversal), None);
        assert_eq!(parse_storyboard(INFO_URL, nested), None);
        assert_eq!(parse_storyboard(INFO_URL, no_interval), None);
        assert_eq!(
            parse_storyboard(INFO_URL, b"<Error>AccessDenied</Error>"),
            None
        );
        assert_eq!(parse_storyboard(INFO_URL, b"[]"), None);
    }

    #[test]
    fn should_derive_kick_frames_from_the_ivs_playlist() {
        // Arrange
        let source = "https://stream.kick.com/ivs/v1/196233775518/AbCd/2026/10/30/19/22/XyZ/media/hls/master.m3u8";

        // Act
        let finished = kick_frames(source, 55409, false);
        let recording = kick_frames(source, 600, true);

        // Assert
        assert_eq!(
            finished,
            Some(VodPreviews::Frames {
                url_prefix: "https://stream.kick.com/ivs/v1/196233775518/AbCd/2026/10/30/19/22/XyZ/media/thumbnails/thumb".into(),
                interval: 60,
                first: 1,
                last: Some(923),
            })
        );
        assert!(matches!(
            recording,
            Some(VodPreviews::Frames { last: None, .. })
        ));
    }

    #[test]
    fn should_not_guess_frames_for_other_playlist_layouts() {
        // Act / Assert
        assert_eq!(
            kick_frames("https://example.com/vod/playlist.m3u8", 600, false),
            None
        );
        assert_eq!(
            kick_frames("http://stream.kick.com/x/media/hls/master.m3u8", 600, false),
            None
        );
    }

    #[test]
    fn should_serialize_previews_with_a_kind_tag() {
        // Arrange
        let frames = VodPreviews::Frames {
            url_prefix: "https://x/thumb".into(),
            interval: 60,
            first: 1,
            last: None,
        };

        // Act
        let json = serde_json::to_value(&frames).unwrap();

        // Assert
        assert_eq!(
            json,
            serde_json::json!({ "kind": "frames", "urlPrefix": "https://x/thumb", "interval": 60, "first": 1 })
        );
    }
}

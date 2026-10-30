use base64::Engine;
use serde_json::{json, Value};

use super::error::VodError;
use super::proxy::rewrite_master_playlist;
use super::types::{http_client, is_valid_channel, parse_timestamp_ms, Vod, VodPage};

const GQL_URL: &str = "https://gql.twitch.tv/gql";
const WEB_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const PAGE_SIZE: u32 = 30;

const VOD_FIELDS: &str = "id title createdAt lengthSeconds status previewThumbnailURL(width: 320, height: 180) viewCount game { displayName } owner { login displayName }";

pub fn is_valid_vod_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 20 && id.chars().all(|c| c.is_ascii_digit())
}

async fn gql(body: Value) -> Result<Value, VodError> {
    let res = http_client()
        .post(GQL_URL)
        .header("Client-ID", WEB_CLIENT_ID)
        .json(&body)
        .send()
        .await?;

    if !res.status().is_success() {
        return Err(VodError::Api(format!("Twitch GQL HTTP {}", res.status())));
    }

    let body: Value = res.json().await?;
    if let Some(msg) = body["errors"]
        .as_array()
        .and_then(|errors| errors.first())
        .and_then(|e| e["message"].as_str())
    {
        return Err(VodError::Api(format!("Twitch GQL: {}", msg)));
    }
    Ok(body)
}

pub(crate) fn parse_vod_node(node: &Value) -> Option<Vod> {
    let id = node["id"].as_str()?.to_string();
    let started_at = parse_timestamp_ms(node["createdAt"].as_str()?)?;
    let channel = node["owner"]["login"].as_str()?.to_string();
    let display_name = node["owner"]["displayName"]
        .as_str()
        .unwrap_or(&channel)
        .to_string();
    // in-progress VODs report a "404_processing" placeholder thumbnail
    let thumbnail_url = node["previewThumbnailURL"]
        .as_str()
        .filter(|url| !url.is_empty() && !url.contains("/_404/"))
        .map(str::to_string);

    Some(Vod {
        id,
        platform: "twitch".into(),
        channel,
        display_name,
        title: node["title"].as_str().unwrap_or_default().to_string(),
        started_at,
        duration_seconds: node["lengthSeconds"].as_u64().unwrap_or(0),
        is_recording: node["status"].as_str() == Some("RECORDING"),
        thumbnail_url,
        category: node["game"]["displayName"].as_str().map(str::to_string),
        view_count: node["viewCount"].as_u64(),
    })
}

pub(crate) fn parse_vod_page(body: &Value) -> Result<VodPage, VodError> {
    let videos = &body["data"]["user"]["videos"];
    if body["data"]["user"].is_null() {
        return Err(VodError::NotFound("Twitch channel".into()));
    }

    let edges = videos["edges"].as_array().cloned().unwrap_or_default();
    let vods = edges
        .iter()
        .filter_map(|e| parse_vod_node(&e["node"]))
        .collect();
    let cursor = if videos["pageInfo"]["hasNextPage"].as_bool() == Some(true) {
        edges
            .last()
            .and_then(|e| e["cursor"].as_str())
            .map(str::to_string)
    } else {
        None
    };

    Ok(VodPage { vods, cursor })
}

pub async fn list_vods(channel: &str, cursor: Option<String>) -> Result<VodPage, VodError> {
    let login = channel.to_lowercase();
    if !is_valid_channel(&login) {
        return Err(VodError::Validation("Invalid channel name".into()));
    }

    let body = gql(json!({
        "query": format!(
            "query($login: String!, $first: Int!, $after: Cursor) {{ user(login: $login) {{ videos(first: $first, after: $after, type: ARCHIVE, sort: TIME) {{ edges {{ cursor node {{ {} }} }} pageInfo {{ hasNextPage }} }} }} }}",
            VOD_FIELDS
        ),
        "variables": { "login": login, "first": PAGE_SIZE, "after": cursor }
    }))
    .await?;

    parse_vod_page(&body)
}

pub async fn get_vod(id: &str) -> Result<Vod, VodError> {
    if !is_valid_vod_id(id) {
        return Err(VodError::Validation("Invalid Twitch VOD id".into()));
    }

    let body = gql(json!({
        "query": format!("query($id: ID!) {{ video(id: $id) {{ {} }} }}", VOD_FIELDS),
        "variables": { "id": id }
    }))
    .await?;

    parse_vod_node(&body["data"]["video"]).ok_or_else(|| VodError::NotFound("Twitch VOD".into()))
}

/// Returns the master playlist as a data URI with every variant routed through the CDN proxy.
pub async fn get_playback_url(id: &str) -> Result<String, VodError> {
    if !is_valid_vod_id(id) {
        return Err(VodError::Validation("Invalid Twitch VOD id".into()));
    }

    let body = gql(json!({
        "query": "query($id: ID!) { videoPlaybackAccessToken(id: $id, params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: \"site\"}) { value signature } }",
        "variables": { "id": id }
    }))
    .await?;

    let token = &body["data"]["videoPlaybackAccessToken"];
    let (Some(value), Some(signature)) = (token["value"].as_str(), token["signature"].as_str())
    else {
        return Err(VodError::NotFound("Twitch VOD".into()));
    };

    let usher_url = format!(
        "https://usher.ttvnw.net/vod/{}.m3u8?client_id={}&token={}&sig={}&allow_source=true&allow_audio_only=true&p={}",
        id,
        WEB_CLIENT_ID,
        urlencoding::encode(value),
        signature,
        rand::random::<u32>() % 9_999_999
    );

    let res = http_client().get(&usher_url).send().await?;
    match res.status().as_u16() {
        403 => return Err(VodError::Restricted("Twitch VOD".into())),
        404 => return Err(VodError::NotFound("Twitch VOD".into())),
        s if !(200..300).contains(&s) => {
            return Err(VodError::Api(format!("Usher HTTP {}", s)));
        }
        _ => {}
    }

    let master = rewrite_master_playlist(&res.text().await?);
    let encoded = base64::engine::general_purpose::STANDARD.encode(master.as_bytes());
    Ok(format!("data:application/x-mpegurl;base64,{}", encoded))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(status: &str, thumb: &str) -> Value {
        json!({
            "id": "2915065087",
            "title": "Worlds",
            "createdAt": "2026-10-30T19:25:36Z",
            "lengthSeconds": 5563,
            "status": status,
            "previewThumbnailURL": thumb,
            "viewCount": 892,
            "game": { "displayName": "League of Legends" },
            "owner": { "login": "ibai", "displayName": "Ibai" }
        })
    }

    #[test]
    fn should_parse_a_recording_vod_and_drop_placeholder_thumbnail() {
        // Arrange
        let raw = node(
            "RECORDING",
            "https://vod-secure.twitch.tv/_404/404_processing_320x180.png",
        );

        // Act
        let vod = parse_vod_node(&raw).unwrap();

        // Assert
        assert_eq!(vod.id, "2915065087");
        assert_eq!(vod.channel, "ibai");
        assert_eq!(vod.display_name, "Ibai");
        assert_eq!(vod.started_at, 1_793_388_336_000);
        assert_eq!(vod.duration_seconds, 5563);
        assert!(vod.is_recording);
        assert!(vod.thumbnail_url.is_none());
        assert_eq!(vod.category.as_deref(), Some("League of Legends"));
    }

    #[test]
    fn should_parse_a_finished_vod_with_thumbnail() {
        // Arrange
        let raw = node(
            "RECORDED",
            "https://static-cdn.jtvnw.net/cf_vods/x/thumb0-320x180.jpg",
        );

        // Act
        let vod = parse_vod_node(&raw).unwrap();

        // Assert
        assert!(!vod.is_recording);
        assert_eq!(
            vod.thumbnail_url.as_deref(),
            Some("https://static-cdn.jtvnw.net/cf_vods/x/thumb0-320x180.jpg")
        );
    }

    #[test]
    fn should_skip_nodes_without_owner_or_date() {
        // Arrange
        let mut raw = node("RECORDED", "");
        raw["owner"] = Value::Null;

        // Act / Assert
        assert!(parse_vod_node(&raw).is_none());
        assert!(parse_vod_node(&Value::Null).is_none());
    }

    #[test]
    fn should_return_cursor_only_when_more_pages_exist() {
        // Arrange
        let with_more = json!({ "data": { "user": { "videos": {
            "edges": [{ "cursor": "abc", "node": node("RECORDED", "") }],
            "pageInfo": { "hasNextPage": true }
        }}}});
        let last_page = json!({ "data": { "user": { "videos": {
            "edges": [{ "cursor": "abc", "node": node("RECORDED", "") }],
            "pageInfo": { "hasNextPage": false }
        }}}});

        // Act
        let first = parse_vod_page(&with_more).unwrap();
        let last = parse_vod_page(&last_page).unwrap();

        // Assert
        assert_eq!(first.vods.len(), 1);
        assert_eq!(first.cursor.as_deref(), Some("abc"));
        assert!(last.cursor.is_none());
    }

    #[test]
    fn should_report_unknown_channel_as_not_found() {
        // Arrange
        let body = json!({ "data": { "user": null } });

        // Act
        let result = parse_vod_page(&body);

        // Assert
        assert!(matches!(result, Err(VodError::NotFound(_))));
    }

    #[test]
    fn should_validate_vod_ids() {
        // Arrange / Act / Assert
        assert!(is_valid_vod_id("2915065087"));
        assert!(!is_valid_vod_id("v2915065087"));
        assert!(!is_valid_vod_id(""));
        assert!(!is_valid_vod_id("1; drop"));
    }
}

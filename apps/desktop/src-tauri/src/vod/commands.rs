use super::error::VodError;
use super::types::{Vod, VodPage};
use super::{kick, twitch};

fn unsupported(platform: &str) -> VodError {
    VodError::Validation(format!(
        "VODs are not supported for platform '{}'",
        platform
    ))
}

#[tauri::command]
pub async fn vod_list(
    platform: String,
    channel: String,
    cursor: Option<String>,
) -> Result<VodPage, VodError> {
    match platform.as_str() {
        "twitch" => twitch::list_vods(&channel, cursor).await,
        "kick" => Ok(VodPage {
            vods: kick::list_vods(&channel).await?,
            cursor: None,
        }),
        other => Err(unsupported(other)),
    }
}

#[tauri::command]
pub async fn vod_get(platform: String, id: String) -> Result<Vod, VodError> {
    match platform.as_str() {
        "twitch" => twitch::get_vod(&id).await,
        "kick" => kick::get_vod(&id).await,
        other => Err(unsupported(other)),
    }
}

#[tauri::command]
pub async fn vod_get_playback_url(platform: String, id: String) -> Result<String, VodError> {
    match platform.as_str() {
        "twitch" => twitch::get_playback_url(&id).await,
        "kick" => kick::get_playback_url(&id).await,
        other => Err(unsupported(other)),
    }
}

//! Twitch only applies Turbo / subscriber ad benefits (and sub-only VOD access) to playback tokens
//! requested with a twitch.tv *website* session. That session is the `auth-token` cookie Twitch sets
//! when the user signs in on twitch.tv inside the app's webview. The app's own OAuth token belongs
//! to a different client id, which GQL rejects for playback.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::webview::Cookie;
use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use super::error::TwitchError;

pub const WEB_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
pub const GQL_URL: &str = "https://gql.twitch.tv/gql";

const TWITCH_URL: &str = "https://www.twitch.tv";
const LOGIN_URL: &str = "https://www.twitch.tv/login";
const AUTH_COOKIE: &str = "auth-token";
const LOGIN_WINDOW: &str = "twitch-web-login";
const MAIN_WINDOW: &str = "main";
const LOGIN_POLL: Duration = Duration::from_secs(1);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub const SESSION_CHANGED_EVENT: &str = "twitch-web-session-changed";

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebSessionState {
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub has_turbo: bool,
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .use_rustls_tls()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("Failed to build Twitch web session HTTP client with rustls-tls")
    })
}

pub(crate) fn find_auth_token(cookies: &[Cookie<'_>]) -> Option<String> {
    cookies
        .iter()
        .find(|c| c.name() == AUTH_COOKIE && !c.value().trim().is_empty())
        .map(|c| c.value().trim().to_string())
}

fn twitch_cookies<R: Runtime>(window: &WebviewWindow<R>) -> Vec<Cookie<'static>> {
    let Ok(url) = tauri::Url::parse(TWITCH_URL) else {
        return Vec::new();
    };
    window.cookies_for_url(url).unwrap_or_default()
}

/// The signed-in twitch.tv session token, if any.
///
/// Must be called from an async command or background task: reading cookies from a synchronous
/// command deadlocks on WebView2.
pub fn auth_token<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let window = app.get_webview_window(MAIN_WINDOW)?;
    find_auth_token(&twitch_cookies(&window))
}

/// Sends a request as the signed-in twitch.tv user when a session exists. If Twitch rejects the
/// session (expired or revoked) the request is retried anonymously so playback never breaks.
pub async fn send_with_session<F>(
    session: Option<&str>,
    build: F,
) -> Result<reqwest::Response, reqwest::Error>
where
    F: Fn(Option<String>) -> reqwest::RequestBuilder,
{
    if let Some(token) = session {
        let res = build(Some(format!("OAuth {}", token))).send().await?;
        if res.status() != reqwest::StatusCode::UNAUTHORIZED {
            return Ok(res);
        }
        log::warn!("[twitch-web] session rejected by Twitch; falling back to anonymous playback");
    }
    build(None).send().await
}

pub(crate) fn parse_current_user(body: &Value) -> WebSessionState {
    let user = &body["data"]["currentUser"];
    let Some(login) = user["login"].as_str() else {
        return WebSessionState::default();
    };
    WebSessionState {
        connected: true,
        login: Some(login.to_string()),
        display_name: user["displayName"].as_str().map(str::to_string),
        has_turbo: user["hasTurbo"].as_bool().unwrap_or(false),
    }
}

async fn session_state(token: &str) -> Result<WebSessionState, TwitchError> {
    let res = http_client()
        .post(GQL_URL)
        .header("Client-ID", WEB_CLIENT_ID)
        .header("Authorization", format!("OAuth {}", token))
        .json(&json!({ "query": "query { currentUser { login displayName hasTurbo } }" }))
        .send()
        .await?;

    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(WebSessionState::default());
    }
    if !res.status().is_success() {
        return Err(TwitchError::Api(format!(
            "Twitch GQL HTTP {}",
            res.status()
        )));
    }
    Ok(parse_current_user(&res.json().await?))
}

async fn current_state<R: Runtime>(app: &AppHandle<R>) -> WebSessionState {
    match auth_token(app) {
        Some(token) => session_state(&token).await.unwrap_or_default(),
        None => WebSessionState::default(),
    }
}

async fn emit_current_state<R: Runtime>(app: &AppHandle<R>) {
    let state = current_state(app).await;
    let _ = app.emit(SESSION_CHANGED_EVENT, state);
}

fn delete_auth_cookies<R: Runtime>(window: &WebviewWindow<R>) {
    for cookie in twitch_cookies(window)
        .into_iter()
        .filter(|c| c.name() == AUTH_COOKIE)
    {
        let _ = window.delete_cookie(cookie);
    }
}

#[tauri::command]
pub async fn twitch_web_session_state(app: AppHandle) -> Result<WebSessionState, TwitchError> {
    Ok(current_state(&app).await)
}

/// Opens twitch.tv's own login page in a separate window and waits for the session cookie.
/// Credentials are entered on Twitch's page; the app only ever reads the resulting cookie.
#[tauri::command]
pub async fn twitch_web_login(app: AppHandle) -> Result<(), TwitchError> {
    if let Some(existing) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = existing.set_focus();
        return Ok(());
    }

    if let Some(token) = auth_token(&app) {
        if session_state(&token).await?.connected {
            emit_current_state(&app).await;
            return Ok(());
        }
        // a stale cookie would make the poll below succeed before the user signs in again
        if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
            delete_auth_cookies(&main);
        }
    }

    let url = LOGIN_URL
        .parse()
        .map_err(|e| TwitchError::Internal(format!("Invalid login URL: {}", e)))?;
    WebviewWindowBuilder::new(&app, LOGIN_WINDOW, WebviewUrl::External(url))
        .title("Twitch")
        .inner_size(520.0, 760.0)
        .center()
        // WebView2 requires every window to share the same user agent and browser arguments
        .user_agent(crate::USER_AGENT)
        .additional_browser_args(crate::BROWSER_ARGS)
        .build()
        .map_err(|e| TwitchError::Internal(format!("Failed to open Twitch login: {}", e)))?;

    tauri::async_runtime::spawn(async move {
        let deadline = Instant::now() + LOGIN_TIMEOUT;
        while Instant::now() < deadline {
            tokio::time::sleep(LOGIN_POLL).await;
            let Some(window) = app.get_webview_window(LOGIN_WINDOW) else {
                // closed by the user before signing in
                emit_current_state(&app).await;
                return;
            };
            if find_auth_token(&twitch_cookies(&window)).is_some() {
                let _ = window.close();
                emit_current_state(&app).await;
                return;
            }
        }
        if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
            let _ = window.close();
        }
        emit_current_state(&app).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn twitch_web_logout(app: AppHandle) -> Result<(), TwitchError> {
    if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
        delete_auth_cookies(&main);
    }
    let _ = app.emit(SESSION_CHANGED_EVENT, WebSessionState::default());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_pick_the_auth_token_cookie() {
        // Arrange
        let cookies = vec![
            Cookie::new("unique_id", "abc"),
            Cookie::new("auth-token", "  tok123  "),
            Cookie::new("login", "jacob"),
        ];

        // Act
        let token = find_auth_token(&cookies);

        // Assert
        assert_eq!(token.as_deref(), Some("tok123"));
    }

    #[test]
    fn should_ignore_missing_or_empty_auth_token() {
        // Arrange
        let none = vec![Cookie::new("login", "jacob")];
        let empty = vec![Cookie::new("auth-token", " ")];

        // Act / Assert
        assert!(find_auth_token(&none).is_none());
        assert!(find_auth_token(&empty).is_none());
    }

    #[test]
    fn should_parse_a_signed_in_turbo_user() {
        // Arrange
        let body = json!({ "data": { "currentUser": {
            "login": "jacob", "displayName": "Jacob", "hasTurbo": true
        }}});

        // Act
        let state = parse_current_user(&body);

        // Assert
        assert_eq!(
            state,
            WebSessionState {
                connected: true,
                login: Some("jacob".into()),
                display_name: Some("Jacob".into()),
                has_turbo: true,
            }
        );
    }

    #[test]
    fn should_treat_a_null_current_user_as_signed_out() {
        // Arrange
        let body = json!({ "data": { "currentUser": null } });

        // Act
        let state = parse_current_user(&body);

        // Assert
        assert_eq!(state, WebSessionState::default());
    }

    #[test]
    fn should_serialize_session_state_as_camel_case() {
        // Arrange
        let state = WebSessionState {
            connected: true,
            login: Some("jacob".into()),
            display_name: None,
            has_turbo: true,
        };

        // Act
        let json = serde_json::to_string(&state).unwrap();

        // Assert
        assert_eq!(
            json,
            r#"{"connected":true,"login":"jacob","hasTurbo":true}"#
        );
    }
}

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

const TWITCH_DOMAIN: &str = "twitch.tv";
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

fn is_twitch_domain(domain: &str) -> bool {
    let domain = domain.trim_start_matches('.');
    domain == TWITCH_DOMAIN || domain.ends_with(".twitch.tv")
}

pub(crate) fn is_twitch_cookie(cookie: &Cookie<'_>) -> bool {
    cookie.domain().is_some_and(is_twitch_domain)
}

// Twitch sets the session on `.twitch.tv` or on `www.twitch.tv` depending on the login path, and
// wry's macOS `cookies_for_url` only returns cookies whose domain equals the URL's host, which
// misses the first. Filtering every cookie by domain finds both.
fn twitch_cookies<R: Runtime>(window: &WebviewWindow<R>) -> Vec<Cookie<'static>> {
    window
        .cookies()
        .unwrap_or_default()
        .into_iter()
        .filter(is_twitch_cookie)
        .collect()
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

// Signing out clears every twitch.tv cookie: twitch.tv's own pages rebuild `auth-token` from
// `twilight-user` and `persistent`, so deleting `auth-token` alone signs straight back in.
#[cfg(not(target_os = "macos"))]
async fn delete_twitch_cookies<R: Runtime>(app: &AppHandle<R>) {
    let Some(main) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    for cookie in twitch_cookies(&main) {
        let _ = main.delete_cookie(cookie);
    }
}

// wry rebuilds a cookie from its dot-less domain before deleting it, and WebKit treats that as a
// different, host-only cookie, so `.twitch.tv` cookies would survive. Delete WebKit's own cookie
// objects instead (Tauri windows share the default data store).
#[cfg(target_os = "macos")]
async fn delete_twitch_cookies<R: Runtime>(app: &AppHandle<R>) {
    use std::cell::Cell;
    use std::ptr::NonNull;
    use std::rc::Rc;

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSArray, NSHTTPCookie};
    use objc2_web_kit::WKWebsiteDataStore;

    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let _ = app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let done = Rc::new(Cell::new(Some(tx)));
        let finish = move |done: &Cell<Option<tokio::sync::oneshot::Sender<()>>>| {
            if let Some(tx) = done.take() {
                let _ = tx.send(());
            }
        };
        // SAFETY: called on the main thread, as WebKit requires
        let store = unsafe { WKWebsiteDataStore::defaultDataStore(mtm).httpCookieStore() };
        let delete_from = store.clone();
        let on_cookies = RcBlock::new(move |cookies: NonNull<NSArray<NSHTTPCookie>>| {
            // SAFETY: WebKit passes a valid array for the duration of the callback
            let twitch: Vec<_> = unsafe { cookies.as_ref() }
                .to_vec()
                .into_iter()
                .filter(|c| is_twitch_domain(&c.domain().to_string()))
                .collect();
            if twitch.is_empty() {
                finish(&done);
                return;
            }
            let remaining = Rc::new(Cell::new(twitch.len()));
            for cookie in twitch {
                let (done, remaining) = (done.clone(), remaining.clone());
                let on_deleted = RcBlock::new(move || {
                    remaining.set(remaining.get() - 1);
                    if remaining.get() == 0 {
                        finish(&done);
                    }
                });
                // SAFETY: still on the main thread inside WebKit's callback
                unsafe { delete_from.deleteCookie_completionHandler(&cookie, Some(&on_deleted)) };
            }
        });
        // SAFETY: called on the main thread, as WebKit requires
        unsafe { store.getAllCookies(&on_cookies) };
    });
    let _ = tokio::time::timeout(Duration::from_secs(5), rx).await;
}

// Twitch's login runs Kasada bot detection, which rejects a WebKit engine that claims to be Chrome
// ("Your browser is not currently supported"), so the login window must not spoof Chrome there.
// WebKitGTK's default user agent already reads as Safari. WebView2 requires every window to share
// one user agent, so Windows keeps the app-wide one.
#[cfg(target_os = "windows")]
fn login_user_agent() -> Option<String> {
    Some(crate::USER_AGENT.to_string())
}

#[cfg(target_os = "macos")]
fn login_user_agent() -> Option<String> {
    let info = std::fs::read_to_string("/Applications/Safari.app/Contents/Info.plist").ok()?;
    safari_user_agent(&info)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn login_user_agent() -> Option<String> {
    None
}

/// Safari's user agent for the version in Safari's `Info.plist`, matching WKWebView's engine.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn safari_user_agent(info_plist: &str) -> Option<String> {
    let key = info_plist.find("<key>CFBundleShortVersionString</key>")?;
    let rest = &info_plist[key..];
    let start = rest.find("<string>")? + "<string>".len();
    let end = start + rest[start..].find("</string>")?;
    let version = rest[start..end].trim();
    if version.is_empty() || !version.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    Some(format!(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{} Safari/605.1.15",
        version
    ))
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
        delete_twitch_cookies(&app).await;
    }

    let url = LOGIN_URL
        .parse()
        .map_err(|e| TwitchError::Internal(format!("Invalid login URL: {}", e)))?;
    let mut builder = WebviewWindowBuilder::new(&app, LOGIN_WINDOW, WebviewUrl::External(url))
        .title("Twitch")
        .inner_size(520.0, 760.0)
        .center()
        .additional_browser_args(crate::BROWSER_ARGS);
    if let Some(user_agent) = login_user_agent() {
        builder = builder.user_agent(&user_agent);
    }
    builder
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
    delete_twitch_cookies(&app).await;
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

    #[test]
    fn should_match_twitch_cookies_on_the_root_domain_and_subdomains() {
        // Arrange
        let cookie = |domain: &str| {
            Cookie::build(("auth-token", "tok"))
                .domain(domain.to_string())
                .build()
        };

        // Act / Assert
        assert!(is_twitch_cookie(&cookie(".twitch.tv")));
        assert!(is_twitch_cookie(&cookie("twitch.tv")));
        assert!(is_twitch_cookie(&cookie("www.twitch.tv")));
        assert!(!is_twitch_cookie(&cookie("nottwitch.tv")));
        assert!(!is_twitch_cookie(&cookie("twitch.tv.example.com")));
        assert!(!is_twitch_cookie(&Cookie::new("auth-token", "tok")));
    }

    #[test]
    fn should_build_a_safari_user_agent_from_its_info_plist() {
        // Arrange
        let plist = r#"<dict>
	<key>CFBundleIdentifier</key>
	<string>com.apple.Safari</string>
	<key>CFBundleShortVersionString</key>
	<string>27.0.1</string>
	<key>CFBundleVersion</key>
	<string>21624.1.12</string>
</dict>"#;

        // Act
        let user_agent = safari_user_agent(plist);

        // Assert
        assert_eq!(
            user_agent.as_deref(),
            Some("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Safari/605.1.15")
        );
    }

    #[test]
    fn should_not_build_a_safari_user_agent_without_a_clean_version() {
        // Act / Assert
        assert_eq!(safari_user_agent("<dict></dict>"), None);
        assert_eq!(
            safari_user_agent("<key>CFBundleShortVersionString</key><string>27 beta\"</string>"),
            None
        );
    }
}

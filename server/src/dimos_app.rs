//! What dimOS Desktop tells this server at start: the `DIMOS_APP` env var, one JSON object (docs/apps.md in
//! dimos-desktop). Desktops from before 2026-10-05 don't set it; their flags and env vars are the fallback.

use std::sync::OnceLock;

#[derive(serde::Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct DimosApp {
    pub version: u64,
    pub name: Option<String>,
    pub socket: Option<String>,
    pub url: Option<String>,
    pub path: Option<String>,
    pub data_dir: Option<String>,
    pub desktop_url: Option<String>,
    pub zenoh_gateway_url: Option<String>,
    /// deprecated: the gateway at its old path, /zenoh-web (Desktops before zenoh-gateway 0.5 set only this)
    pub zenoh_web_url: Option<String>,
    pub zenoh_connect: Option<String>,
    pub dimos_dir: Option<String>,
    pub dimos_python: Option<String>,
    pub recordings_dir: Option<String>,
    /// `<ns>`, the namespace of Desktop's zenoh keys (Desktop's docs/events.md)
    pub zenoh_namespace: Option<String>,
    /// `<ns>/apps/<name>`: this app's keys; pages hear `<zenohPrefix>/frontend/<topic>`
    pub zenoh_prefix: Option<String>,
}

pub fn parse(json: &str) -> Result<DimosApp, serde_json::Error> {
    serde_json::from_str(json)
}

/// DIMOS_APP, parsed once (logged once, so the App Store's log shows what the app was given); None when unset.
pub fn get() -> Option<&'static DimosApp> {
    static APP: OnceLock<Option<DimosApp>> = OnceLock::new();
    APP.get_or_init(|| {
        let json = std::env::var("DIMOS_APP")
            .ok()
            .filter(|json| !json.is_empty())?;
        eprintln!("DIMOS_APP: {json}");
        parse(&json)
            .map_err(|error| eprintln!("DIMOS_APP isn't valid JSON ({error}); using the flags"))
            .ok()
    })
    .as_ref()
}

/// A DIMOS_APP field, else the older env var Desktop also sets.
pub fn field(pick: impl Fn(&DimosApp) -> Option<&String>, env: &str) -> Option<String> {
    get()
        .and_then(|app| pick(app).cloned())
        .or_else(|| std::env::var(env).ok())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_desktops_json() {
        let app = parse(r#"{"version":1,"name":"b","socket":"/s/b.sock","url":"http://127.0.0.1:7341/apps/b/","path":"/apps/b/","dataDir":"/d/b","desktopUrl":"http://127.0.0.1:7341","zenohConnect":"","zenohNamespace":"ns","zenohPrefix":"ns/apps/b","later":"ignored"}"#).unwrap();
        assert_eq!(app.version, 1);
        assert_eq!(app.name.as_deref(), Some("b"));
        assert_eq!(app.socket.as_deref(), Some("/s/b.sock"));
        assert_eq!(app.data_dir.as_deref(), Some("/d/b"));
        assert_eq!(app.desktop_url.as_deref(), Some("http://127.0.0.1:7341"));
        assert_eq!(app.zenoh_connect.as_deref(), Some(""));
        assert_eq!(app.zenoh_gateway_url, None);
        assert_eq!(app.zenoh_prefix.as_deref(), Some("ns/apps/b"));
        assert_eq!(app.zenoh_namespace.as_deref(), Some("ns"));
    }
}

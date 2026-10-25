//! What dimOS Desktop tells this server at start: the `DIMOS_APP` env var, one JSON object (docs/apps.md in
//! dimos-desktop), the whole interface: Desktop passes no flags or other variables.

use std::path::PathBuf;
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
    pub zenoh_connect: Option<String>,
    pub dimos_dir: Option<String>,
    pub dimos_python: Option<String>,
    pub recordings_dir: Option<String>,
    /// `<ns>`, the namespace of Desktop's zenoh keys (Desktop's docs/events.md)
    pub zenoh_namespace: Option<String>,
    /// `<ns>/apps/<name>`: this app's keys; pages hear `<zenohPrefix>/frontend/<topic>`
    pub zenoh_prefix: Option<String>,
    /// this app's secrets (its zenohGatewayToken among them): never print it, never pass it on
    /// which computer this is, for a recording's name (Desktop 0.2.226 and newer; older ones leave it out)
    pub machine_id: Option<String>,
    pub secrets: Option<std::collections::BTreeMap<String, String>>,
}

/// `DIMOS_APP`'s JSON without its `secrets`: what may be printed.
///
/// Desktop redacts the zenoh-gateway token out of the log it serves precisely because apps print this object at
/// startup. `secrets` is the section that makes that unnecessary, so the whole of it goes rather than one key of it,
/// and the next secret is covered without a change here.
fn loggable(json: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(json) else {
        return "(not valid JSON)".to_string();
    };
    if let Some(map) = value.as_object_mut() {
        map.remove("secrets");
    }
    value.to_string()
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
        eprintln!("DIMOS_APP: {}", loggable(&json));
        parse(&json)
            .map_err(|error| eprintln!("DIMOS_APP isn't valid JSON ({error}); ignoring it"))
            .ok()
    })
    .as_ref()
}

/// A DIMOS_APP field, None when it's unset or empty.
pub fn field(pick: impl Fn(&DimosApp) -> Option<&String>) -> Option<String> {
    get()
        .and_then(|app| pick(app).cloned())
        .filter(|value| !value.is_empty())
}

/// The app's own writable folder, where everything it saves goes: DIMOS_APP's `dataDir`, the one Desktop makes for it.
/// Outside Desktop (no DIMOS_APP) it keeps its own, next to the hook's cache (hook_install.rs); rebuilding Desktop's
/// own layout by hand would be reading exactly what DIMOS_APP is there to say.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = field(|app| app.data_dir.as_ref()) {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("dim-controller")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_desktops_json() {
        let app = parse(r#"{"version":2,"name":"b","socket":"/s/b.sock","url":"http://127.0.0.1:7341/apps/b/","path":"/apps/b/","dataDir":"/d/b","desktopUrl":"http://127.0.0.1:7341","zenohConnect":"","zenohNamespace":"ns","zenohPrefix":"ns/apps/b","later":"ignored"}"#).unwrap();
        assert_eq!(app.version, 2);
        assert_eq!(app.name.as_deref(), Some("b"));
        assert_eq!(app.socket.as_deref(), Some("/s/b.sock"));
        assert_eq!(app.data_dir.as_deref(), Some("/d/b"));
        assert_eq!(app.desktop_url.as_deref(), Some("http://127.0.0.1:7341"));
        assert_eq!(app.zenoh_connect.as_deref(), Some(""));
        assert_eq!(app.zenoh_gateway_url, None);
        assert_eq!(app.zenoh_prefix.as_deref(), Some("ns/apps/b"));
        assert_eq!(app.zenoh_namespace.as_deref(), Some("ns"));
    }
    /// What may be printed leaves the whole `secrets` section out, whatever is in it: that is what makes Desktop's
    /// redaction of the zenoh-gateway token unnecessary, and covers the next secret without a change here.
    #[test]
    fn what_is_printed_has_no_secrets_in_it() {
        let json = r#"{"name":"b","machineId":"3f8a","secrets":{"zenohGatewayToken":"b.deadbeef","next":"also-secret"}}"#;
        let shown = loggable(json);
        assert!(!shown.contains("secrets"), "{shown}");
        assert!(!shown.contains("deadbeef"), "{shown}");
        assert!(!shown.contains("also-secret"), "{shown}");
        assert!(shown.contains("3f8a"), "the rest is still shown: {shown}");
        let app = parse(json).unwrap();
        assert_eq!(app.secrets.as_ref().and_then(|s| s.get("zenohGatewayToken")).map(String::as_str), Some("b.deadbeef"));
        assert_eq!(loggable("{not json"), "(not valid JSON)");
    }
}

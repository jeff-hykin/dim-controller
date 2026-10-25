//! Snapshots: pictures of the 3D view or a camera view the page took (its snapshot buttons), kept as PNGs in
//! `snapshots/` in the app's data dir, so every page's gallery shows the same ones. Each file is named
//! `<unix ms>_<view>_<source>.png`, which is all there is to know about it. A change is an
//! `{type: "snapshots", snapshots}` event on the page event stream.
use std::path::{Path as FilePath, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{Path, Query, State as Extract};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use serde_json::json;

use crate::api::Api;

/// the biggest picture a page may send (a 4K view as PNG is a few MB; axum's default limit is 2 MB)
pub const MAX_BYTES: usize = 64 * 1024 * 1024;

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

#[derive(Serialize, Debug, PartialEq)]
pub struct Snapshot {
    pub name: String,
    /// what was captured: "3d" or "camera"
    pub view: String,
    /// the camera topic (or "3d"), as far as a file name keeps it
    pub source: String,
    /// unix ms
    pub created: u64,
    pub bytes: u64,
}

fn error(status: StatusCode, message: impl std::fmt::Display) -> Response {
    (status, Json(json!({ "error": message.to_string() }))).into_response()
}

/// Letters, digits, `.` and `-` kept, runs of anything else one `-` (`_` separates the name's parts).
fn clean(text: &str) -> String {
    let mut out = String::new();
    for character in text.chars() {
        if character.is_ascii_alphanumeric() || character == '.' || character == '-' {
            out.push(character);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(80).collect()
}

/// A file name's parts, or None for a file that isn't a snapshot.
fn parse(name: &str) -> Option<(u64, String, String)> {
    let stem = name.strip_suffix(".png")?;
    let mut parts = stem.splitn(3, '_');
    let created = parts.next()?.parse().ok()?;
    let view = parts.next()?.to_string();
    let source = parts.next().unwrap_or("").to_string();
    Some((created, view, source))
}

/// The snapshot file `name` names in `dir`: a plain snapshot file name only (no paths).
fn resolve(dir: &FilePath, name: &str) -> Result<PathBuf, Response> {
    let plain = !name.contains(['/', '\\']) && name != "." && name != "..";
    if !plain || parse(name).is_none() {
        return Err(error(StatusCode::BAD_REQUEST, "not a snapshot name (as GET api/snapshots lists them)"));
    }
    Ok(dir.join(name))
}

/// Every snapshot in `dir`, newest first.
pub fn list_in(dir: &FilePath) -> Vec<Snapshot> {
    let mut snapshots: Vec<Snapshot> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let (created, view, source) = parse(&name)?;
            let bytes = entry.metadata().ok()?.len();
            Some(Snapshot { name, view, source, created, bytes })
        })
        .collect();
    snapshots.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| b.name.cmp(&a.name)));
    snapshots
}

fn changed(api: &Api) -> Vec<Snapshot> {
    let snapshots = list_in(&api.snapshots);
    api.annotations.broadcast(json!({ "type": "snapshots", "snapshots": snapshots }));
    snapshots
}

pub async fn list(Extract(api): Extract<Api>) -> Response {
    Json(json!({ "snapshots": list_in(&api.snapshots) })).into_response()
}

pub async fn save(Extract(api): Extract<Api>, Query(query): Query<std::collections::HashMap<String, String>>, body: Bytes) -> Response {
    if !body.starts_with(PNG_SIGNATURE) {
        return error(StatusCode::BAD_REQUEST, "the body must be a PNG image");
    }
    let view = match clean(query.get("view").map(String::as_str).unwrap_or("3d")) {
        view if view.is_empty() => "3d".to_string(),
        view => view.to_lowercase(),
    };
    let source = clean(query.get("source").map(String::as_str).unwrap_or(""));
    if let Err(problem) = std::fs::create_dir_all(api.snapshots.as_path()) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, format!("couldn't make {}: {problem}", api.snapshots.display()));
    }
    let mut created = SystemTime::now().duration_since(UNIX_EPOCH).map(|age| age.as_millis() as u64).unwrap_or(0);
    // two in the same millisecond: the second takes the next free one
    let (name, file) = loop {
        let name = format!("{created}_{view}_{source}.png");
        match std::fs::OpenOptions::new().write(true).create_new(true).open(api.snapshots.join(&name)) {
            Ok(file) => break (name, file),
            Err(problem) if problem.kind() == std::io::ErrorKind::AlreadyExists => created += 1,
            Err(problem) => return error(StatusCode::INTERNAL_SERVER_ERROR, format!("couldn't save {name}: {problem}")),
        }
    };
    if let Err(problem) = std::io::Write::write_all(&mut &file, &body) {
        let _ = std::fs::remove_file(api.snapshots.join(&name));
        return error(StatusCode::INTERNAL_SERVER_ERROR, format!("couldn't save {name}: {problem}"));
    }
    let snapshots = changed(&api);
    let snapshot = snapshots.iter().find(|snapshot| snapshot.name == name);
    Json(json!({ "snapshot": snapshot, "snapshots": snapshots })).into_response()
}

pub async fn get(Extract(api): Extract<Api>, Path(name): Path<String>) -> Response {
    let path = match resolve(&api.snapshots, &name) {
        Ok(path) => path,
        Err(response) => return response,
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "private, max-age=31536000, immutable")], bytes).into_response(),
        Err(_) => error(StatusCode::NOT_FOUND, "no such snapshot"),
    }
}

pub async fn delete(Extract(api): Extract<Api>, Path(name): Path<String>) -> Response {
    let path = match resolve(&api.snapshots, &name) {
        Ok(path) => path,
        Err(response) => return response,
    };
    if std::fs::remove_file(&path).is_err() {
        return error(StatusCode::NOT_FOUND, "no such snapshot");
    }
    let snapshots = changed(&api);
    Json(json!({ "ok": true, "removed": name, "snapshots": snapshots })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_carry_time_view_and_source() {
        assert_eq!(clean("dimos/head/left/image/sensor_msgs.Image"), "dimos-head-left-image-sensor-msgs.Image");
        assert_eq!(parse("1761400000000_camera_dimos-color-image.png"), Some((1761400000000, "camera".into(), "dimos-color-image".into())));
        assert_eq!(parse("1761400000000_3d_.png"), Some((1761400000000, "3d".into(), "".into())));
        assert_eq!(parse("notes.png"), None);
        assert_eq!(parse("1761400000000_3d_x.jpg"), None);
        let dir = std::env::temp_dir();
        assert!(resolve(&dir, "../1_3d_.png").is_err());
        assert!(resolve(&dir, "settings.json").is_err());
        assert_eq!(resolve(&dir, "1_3d_.png").ok(), Some(dir.join("1_3d_.png")));
    }
}

//! The recorder and its zenoh side (routes in api.rs). A start names its keys, or leaves them out: then the topics on
//! the bus now are found here (liveliness tokens and a short listen, as Desktop's /api/topics does) minus rpc topics and
//! the ones unticked in the recorder panel (the `lv.record.topics` setting), and while it runs, new ones join (unless
//! `lv.record.options.recordNew` is off) and dimos runs that start later bring their log dirs (Desktop's /dimos/runs).
//! While a recording runs this process subscribes to exactly the recorded keys, so an idle recorder costs no bandwidth.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{Path, State as Extract};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::image::ImageFormat;
use crate::labels::{self, Labels};
use crate::logs::LogTailer;
use crate::record::{self, Compression, Recorder};

#[derive(Clone, Copy, Serialize, Deserialize, Debug, Default)]
pub struct Settings {
    pub compression: Compression,
    pub image_format: ImageFormat,
}

struct Active {
    recorder: Arc<Recorder>,
    subscribers: Vec<zenoh::pubsub::Subscriber<()>>,
    keys: BTreeSet<String>,
    logs: LogTailer,
}

/// Where dimos's jsonl logs are: run log dirs, and logs roots holding one dir per run (logs.rs).
#[derive(Deserialize, Default, Debug)]
pub struct LogDirs {
    #[serde(default)]
    pub log_dirs: Vec<String>,
    #[serde(default)]
    pub log_roots: Vec<String>,
}

impl LogDirs {
    fn paths(list: &[String]) -> Vec<PathBuf> {
        list.iter().map(|dir| dir.trim()).filter(|dir| !dir.is_empty()).map(PathBuf::from).collect()
    }

    fn watch(&self, tailer: &LogTailer) {
        tailer.watch(&Self::paths(&self.log_dirs), &Self::paths(&self.log_roots));
    }
}

pub struct State {
    record_dir: Mutex<PathBuf>,
    settings: Mutex<Settings>,
    zenoh_connect: String,
    session: AsyncMutex<Option<zenoh::Session>>,
    active: AsyncMutex<Option<Active>>,
    /// the session's location labels (labels.rs); written into recordings
    pub labels: Labels,
}

/// `dimos/<topic>/<pkg.Type>` → ("/<topic>", "pkg.Type"); anything else is not a dimos channel.
pub fn split_key(key: &str) -> Option<(String, String)> {
    let rest = key.strip_prefix("dimos/")?;
    let (topic, msg_type) = rest.rsplit_once('/')?;
    let (package, name) = msg_type.split_once('.')?;
    if topic.is_empty() || package.is_empty() || name.is_empty() || key.contains('*') {
        return None;
    }
    Some((format!("/{topic}"), msg_type.to_string()))
}

impl State {
    pub fn new(record_dir: PathBuf, zenoh_connect: String) -> Self {
        State {
            record_dir: Mutex::new(record_dir),
            settings: Mutex::new(Settings::default()),
            zenoh_connect,
            session: AsyncMutex::new(None),
            active: AsyncMutex::new(None),
            labels: Labels::default(),
        }
    }

    pub async fn session(&self) -> anyhow::Result<zenoh::Session> {
        let mut session = self.session.lock().await;
        if let Some(open) = session.as_ref() {
            return Ok(open.clone());
        }
        let mut config = zenoh::Config::default();
        if !self.zenoh_connect.is_empty() {
            // an explicit endpoint is the whole story: no multicast scouting of the LAN
            for (key, value) in [("connect/endpoints", serde_json::to_string(&[&self.zenoh_connect])?), ("scouting/multicast/enabled", "false".into())] {
                config.insert_json5(key, &value).map_err(|error| anyhow::anyhow!("zenoh config {key}: {error}"))?;
            }
        }
        let open = zenoh::open(config).await.map_err(|error| anyhow::anyhow!("zenoh: {error}"))?;
        *session = Some(open.clone());
        Ok(open)
    }

    async fn subscribe(&self, recorder: &Arc<Recorder>, key: &str) -> anyhow::Result<zenoh::pubsub::Subscriber<()>> {
        let (topic, msg_type) = split_key(key).ok_or_else(|| anyhow::anyhow!("not a dimos key: {key}"))?;
        let recorder = recorder.clone();
        let session = self.session().await?;
        session
            .declare_subscriber(key.to_string())
            .callback(move |sample| recorder.offer(&topic, Some(&msg_type), &sample.payload().to_bytes()))
            .await
            .map_err(|error| anyhow::anyhow!("subscribe {key}: {error}"))
    }

    pub async fn start(&self, keys: Vec<String>, name: Option<String>, logs: LogDirs) -> anyhow::Result<record::RecordingStatus> {
        let mut active = self.active.lock().await;
        if active.is_some() {
            anyhow::bail!("already recording");
        }
        let directory = self.record_dir.lock().unwrap().clone();
        let path = record::resolve(&directory, &name.unwrap_or_else(record::default_name))?;
        let settings = *self.settings.lock().unwrap();
        let recorder = Arc::new(Recorder::start(&path, settings.compression, settings.image_format)?);
        // the labels made so far are part of the picture: they open the recording
        for label in self.labels.list() {
            labels::write(&recorder, &label, "add");
        }
        let tailer = LogTailer::start(recorder.clone());
        logs.watch(&tailer);
        let mut started = Active { recorder: recorder.clone(), subscribers: Vec::new(), keys: BTreeSet::new(), logs: tailer };
        for key in keys {
            if started.keys.insert(key.clone()) {
                started.subscribers.push(self.subscribe(&recorder, &key).await?);
            }
        }
        let status = recorder.status();
        *active = Some(started);
        Ok(status)
    }

    /// Topics that appeared mid-recording join it.
    pub async fn add(&self, keys: Vec<String>) -> anyhow::Result<usize> {
        let mut active = self.active.lock().await;
        let Some(active) = active.as_mut() else {
            anyhow::bail!("not recording");
        };
        let mut added = 0;
        for key in keys {
            if active.keys.insert(key.clone()) {
                active.subscribers.push(self.subscribe(&active.recorder, &key).await?);
                added += 1;
            }
        }
        Ok(added)
    }

    /// Log dirs found mid-recording (a run that started after it) join it.
    pub async fn add_logs(&self, logs: LogDirs) -> anyhow::Result<Vec<String>> {
        let active = self.active.lock().await;
        let Some(active) = active.as_ref() else {
            anyhow::bail!("not recording");
        };
        logs.watch(&active.logs);
        Ok(active.logs.dirs())
    }

    /// Writes a label change into the recording if one is running; says whether it did.
    pub async fn record_label(&self, label: &labels::Label, action: &str) -> bool {
        match self.active.lock().await.as_ref() {
            Some(active) => {
                labels::write(&active.recorder, label, action);
                true
            }
            None => false,
        }
    }

    pub async fn stop(&self) -> anyhow::Result<record::RecordingStatus> {
        let Some(active) = self.active.lock().await.take() else {
            anyhow::bail!("not recording");
        };
        // undeclare first so nothing is offered after the writer closes
        for subscriber in active.subscribers {
            let _ = subscriber.undeclare().await;
        }
        let (recorder, logs) = (active.recorder, active.logs);
        tokio::task::spawn_blocking(move || {
            // the log tail's last pass writes into the recorder, so it stops first
            logs.stop();
            recorder.finish()
        })
        .await?
    }

    /// The dimos keys on the bus now: liveliness tokens, plus what is heard in a short listen.
    pub async fn discover(&self) -> anyhow::Result<Vec<String>> {
        let session = self.session().await?;
        let found: Arc<Mutex<BTreeSet<String>>> = Arc::default();
        let sink = found.clone();
        let listener = session
            .declare_subscriber("dimos/**")
            .callback(move |sample| {
                sink.lock().unwrap().insert(sample.key_expr().as_str().to_string());
            })
            .await
            .map_err(|error| anyhow::anyhow!("zenoh: {error}"))?;
        for selector in ["dimos/**", "dimos/**/@adv/pub/**"] {
            if let Ok(replies) = session.liveliness().get(selector).timeout(std::time::Duration::from_millis(400)).await {
                while let Ok(reply) = replies.recv_async().await {
                    if let Ok(sample) = reply.result() {
                        let token = sample.key_expr().as_str();
                        found.lock().unwrap().insert(token.split_once("/@adv/pub/").map_or(token, |(key, _)| key).to_string());
                    }
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let _ = listener.undeclare().await;
        let keys = found.lock().unwrap().iter().filter(|key| split_key(key).is_some()).cloned().collect();
        Ok(keys)
    }

    pub async fn is_recording(&self, path: &Option<String>) -> bool {
        self.active.lock().await.as_ref().is_some_and(|active| active.recorder.status().path == *path)
    }

    pub async fn status(&self) -> Status {
        let active = self.active.lock().await;
        let directory = self.record_dir.lock().unwrap().clone();
        Status {
            recording: active.as_ref().map(|active| active.recorder.status()).unwrap_or_else(record::idle_status),
            keys: active.as_ref().map(|active| active.keys.iter().cloned().collect()).unwrap_or_default(),
            logs: active.as_ref().map(|active| LogStatus { dirs: active.logs.dirs(), lines: active.logs.lines() }).unwrap_or_default(),
            files: record::list(&directory),
            settings: *self.settings.lock().unwrap(),
            directory: directory.display().to_string(),
        }
    }
}

#[derive(Serialize)]
pub struct Status {
    pub recording: record::RecordingStatus,
    pub keys: Vec<String>,
    /// the log dirs being tailed and the lines written so far (while recording)
    logs: LogStatus,
    files: Vec<record::RecordingFile>,
    settings: Settings,
    directory: String,
}

#[derive(Serialize, Default)]
struct LogStatus {
    dirs: Vec<String>,
    lines: u64,
}

#[derive(Deserialize)]
pub struct SettingsBody {
    compression: Option<Compression>,
    image_format: Option<ImageFormat>,
    directory: Option<String>,
}

fn error(status: StatusCode, error: impl std::fmt::Display) -> Response {
    (status, Json(json!({ "error": error.to_string() }))).into_response()
}

/// rpc request/reply topics are off unless ticked
pub fn is_rpc(topic: &str) -> bool {
    topic.starts_with("/rpc/") || topic.ends_with("/req") || topic.ends_with("/res")
}

/// The keys a start without keys records: what is on the bus minus rpc topics and the ones unticked in the panel.
pub fn wanted(keys: &[String], chosen: &Value) -> Vec<String> {
    keys.iter()
        .filter(|key| {
            let topic = split_key(key).map(|(topic, _)| topic).unwrap_or_default();
            chosen[key.as_str()].as_bool().unwrap_or(!is_rpc(&topic))
        })
        .cloned()
        .collect()
}

pub async fn status(Extract(state): Extract<Arc<State>>) -> Response {
    Json(state.status().await).into_response()
}

pub async fn start(Extract(api): Extract<crate::api::Api>, crate::api::Body(body): crate::api::Body) -> Response {
    let state = api.recorder.clone();
    let explicit: Option<Vec<String>> = match body.get("keys") {
        None | Some(Value::Null) => None,
        Some(keys) => match serde_json::from_value(keys.clone()) {
            Ok(keys) => Some(keys),
            Err(_) => return error(StatusCode::BAD_REQUEST, "keys: a list of dimos keys (dimos/<topic>/<pkg.Type>)"),
        },
    };
    let follow = explicit.is_none();
    let keys = match explicit {
        Some(keys) => keys,
        None => match state.discover().await {
            Ok(keys) => wanted(&keys, &api.settings.get("lv.record.topics")),
            Err(problem) => return error(StatusCode::SERVICE_UNAVAILABLE, problem),
        },
    };
    let given: Option<LogDirs> = if body.get("log_dirs").is_some() || body.get("log_roots").is_some() { serde_json::from_value(body.clone()).ok() } else { None };
    let logs = match given {
        Some(logs) => logs,
        None => crate::desktop::log_dirs(&api.desktop_url, true).await,
    };
    let name = body["name"].as_str().map(str::to_string);
    match state.start(keys, name, logs).await {
        Ok(status) => {
            follow_recording(api, status.path.clone(), follow);
            Json(status).into_response()
        }
        Err(problem) => error(StatusCode::CONFLICT, problem),
    }
}

/// While this recording runs: dimos runs that start later bring their log dirs; with `topics`, new topics join.
fn follow_recording(api: crate::api::Api, path: Option<String>, topics: bool) {
    tokio::spawn(async move {
        let mut tick = 0u64;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            if !api.recorder.is_recording(&path).await {
                return;
            }
            tick += 1;
            let record_new = api.settings.get("lv.record.options")["recordNew"].as_bool().unwrap_or(true);
            if topics && record_new {
                if let Ok(keys) = api.recorder.discover().await {
                    let _ = api.recorder.add(wanted(&keys, &api.settings.get("lv.record.topics"))).await;
                }
            }
            if tick % 2 == 0 {
                let dirs = crate::desktop::log_dirs(&api.desktop_url, false).await;
                if !dirs.log_dirs.is_empty() {
                    let _ = api.recorder.add_logs(dirs).await;
                }
            }
        }
    });
}

pub async fn add(Extract(state): Extract<Arc<State>>, crate::api::Body(body): crate::api::Body) -> Response {
    let keys: Vec<String> = match serde_json::from_value(body["keys"].clone()) {
        Ok(keys) => keys,
        Err(_) => return error(StatusCode::BAD_REQUEST, "keys: a list of dimos keys"),
    };
    match state.add(keys).await {
        Ok(added) => Json(json!({ "added": added })).into_response(),
        Err(problem) => error(StatusCode::CONFLICT, problem),
    }
}

pub async fn add_logs(Extract(state): Extract<Arc<State>>, crate::api::Body(body): crate::api::Body) -> Response {
    let logs: LogDirs = serde_json::from_value(body).unwrap_or_default();
    match state.add_logs(logs).await {
        Ok(dirs) => Json(json!({ "dirs": dirs })).into_response(),
        Err(problem) => error(StatusCode::CONFLICT, problem),
    }
}

pub async fn stop(Extract(state): Extract<Arc<State>>) -> Response {
    match state.stop().await {
        Ok(status) => Json(status).into_response(),
        Err(problem) => error(StatusCode::CONFLICT, problem),
    }
}

pub async fn settings(Extract(state): Extract<Arc<State>>, crate::api::Body(body): crate::api::Body) -> Response {
    let body: SettingsBody = match serde_json::from_value(body) {
        Ok(body) => body,
        Err(problem) => return error(StatusCode::BAD_REQUEST, problem),
    };
    if state.active.lock().await.is_some() {
        return error(StatusCode::CONFLICT, "can't change settings while recording");
    }
    {
        let mut settings = state.settings.lock().unwrap();
        if let Some(compression) = body.compression {
            settings.compression = compression;
        }
        if let Some(format) = body.image_format {
            settings.image_format = format;
        }
    }
    if let Some(directory) = body.directory.filter(|directory| !directory.trim().is_empty()) {
        *state.record_dir.lock().unwrap() = PathBuf::from(directory.trim());
    }
    Json(state.status().await).into_response()
}

pub async fn delete_file(Extract(state): Extract<Arc<State>>, Path(name): Path<String>) -> Response {
    let directory = state.record_dir.lock().unwrap().clone();
    let path = match record::resolve(&directory, &name) {
        Ok(path) => path,
        Err(problem) => return error(StatusCode::BAD_REQUEST, problem),
    };
    if let Some(active) = state.active.lock().await.as_ref() {
        if active.recorder.is_writing_to(&path) {
            return error(StatusCode::CONFLICT, "that recording is still running");
        }
    }
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Json(json!({ "ok": true, "removed": name })).into_response(),
        Err(problem) => error(StatusCode::NOT_FOUND, problem),
    }
}

pub async fn download_file(Extract(state): Extract<Arc<State>>, Path(name): Path<String>) -> Response {
    let directory = state.record_dir.lock().unwrap().clone();
    let path = match record::resolve(&directory, &name) {
        Ok(path) => path,
        Err(problem) => return error(StatusCode::BAD_REQUEST, problem),
    };
    match tokio::fs::File::open(&path).await {
        Ok(file) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{name}\"")),
            ],
            Body::from_stream(tokio_util::io::ReaderStream::new(file)),
        )
            .into_response(),
        Err(problem) => error(StatusCode::NOT_FOUND, problem),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;

    #[test]
    fn dimos_keys_split_into_topic_and_type() {
        assert_eq!(split_key("dimos/odom/nav_msgs.Odometry"), Some(("/odom".into(), "nav_msgs.Odometry".into())));
        assert_eq!(split_key("dimos/head/left/image/sensor_msgs.Image"), Some(("/head/left/image".into(), "sensor_msgs.Image".into())));
        assert_eq!(split_key("dimos/**"), None);
        assert_eq!(split_key("other/odom/nav_msgs.Odometry"), None);
        assert_eq!(split_key("dimos/odom/notatype"), None);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("live_viewer_test_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn call(app: &axum::Router, method: &str, uri: &str, body: &str) -> (StatusCode, serde_json::Value) {
        let request = Request::builder().method(method).uri(uri).header("content-type", "application/json").body(Body::from(body.to_string())).unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
    }

    #[tokio::test]
    async fn status_lists_files_and_refuses_paths_outside_the_directory() {
        let dir = temp_dir("status");
        std::fs::write(dir.join("a.mcap"), b"x").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        let app = crate::api::test_router(Arc::new(State::new(dir.clone(), String::new())));
        let (status, body) = call(&app, "GET", "/api/recorder", "").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["recording"]["active"], false);
        let names: Vec<_> = body["files"].as_array().unwrap().iter().map(|file| file["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, vec!["a.mcap"]);
        let (status, _) = call(&app, "DELETE", "/api/recorder/files/..%2Fnotes.txt", "").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = call(&app, "DELETE", "/api/recorder/files/a.mcap", "").await;
        assert_eq!(status, StatusCode::OK);
        assert!(!dir.join("a.mcap").exists());
        let (status, _) = call(&app, "POST", "/api/recorder/stop", "").await;
        assert_eq!(status, StatusCode::CONFLICT);
    }

    /// A real zenoh round trip on loopback: what's published on a chosen key lands in the mcap under its topic.
    #[tokio::test(flavor = "multi_thread")]
    async fn records_chosen_keys_from_zenoh_into_an_mcap() {
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let mut config = zenoh::Config::default();
        config.insert_json5("listen/endpoints", &format!(r#"["tcp/127.0.0.1:{port}"]"#)).unwrap();
        config.insert_json5("scouting/multicast/enabled", "false").unwrap();
        let robot = zenoh::open(config).await.unwrap();
        let dir = temp_dir("zenoh");
        let state = Arc::new(State::new(dir.clone(), format!("tcp/127.0.0.1:{port}")));
        let app = crate::api::test_router(state.clone());
        let (status, body) = call(&app, "POST", "/api/recorder/start", r#"{"keys":["dimos/test_cmd/geometry_msgs.Twist"],"name":"zenoh.mcap"}"#).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let twist = crate::msgs::encode_twist([0.5, 0.0, 0.0], [0.0, 0.0, 0.25]);
        for _ in 0..5 {
            robot.put("dimos/test_cmd/geometry_msgs.Twist", twist.clone()).await.unwrap();
            robot.put("dimos/not_chosen/geometry_msgs.Twist", twist.clone()).await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let (status, body) = call(&app, "POST", "/api/recorder/stop", "").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["messages"], 5);
        let bytes = std::fs::read(dir.join("zenoh.mcap")).unwrap();
        let topics: Vec<String> = mcap::MessageStream::new(&bytes).unwrap().map(|message| message.unwrap().channel.topic.clone()).collect();
        assert_eq!(topics, vec!["/test_cmd"; 5]);
        robot.close().await.unwrap();
    }

    /// Through the HTTP API: a label made before the recording, one during it, one deleted, and dimos log lines written
    /// during it all land in the mcap on their own channels.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_recording_holds_the_logs_and_the_labels() {
        let dir = temp_dir("logs_labels");
        let run = dir.join("run");
        std::fs::create_dir_all(&run).unwrap();
        std::fs::write(run.join("main.jsonl"), "{\"event\": \"old\", \"level\": \"info\"}\n").unwrap();
        let state = Arc::new(State::new(dir.clone(), String::new()));
        let annotations = Arc::new(crate::annotations::Annotations::default());
        let _ = annotations;
        let app = crate::api::test_router(state.clone());
        let label = |text: &str| format!(r#"{{"label":"{text}","frame_id":"world","position":[1,2,0]}}"#);
        let (status, body) = call(&app, "POST", "/api/labels", &label("before")).await;
        assert_eq!((status, &body["recorded"]), (StatusCode::OK, &serde_json::json!(false)));
        let start = serde_json::json!({ "keys": [], "name": "full.mcap", "log_dirs": [run.display().to_string()] }).to_string();
        let (status, body) = call(&app, "POST", "/api/recorder/start", &start).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (_, body) = call(&app, "POST", "/api/labels", &label("during")).await;
        assert_eq!(body["recorded"], true);
        let id = body["label"]["id"].as_str().unwrap().to_string();
        let (status, _) = call(&app, "DELETE", &format!("/api/labels/{id}"), "").await;
        assert_eq!(status, StatusCode::OK);
        {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new().append(true).open(run.join("main.jsonl")).unwrap();
            writeln!(file, r#"{{"event": "went wrong", "level": "error", "logger": "dimos/x.py", "timestamp": "2026-10-03T08:00:00Z", "lineno": 3}}"#).unwrap();
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let (_, body) = call(&app, "GET", "/api/recorder", "").await;
        assert_eq!(body["logs"]["lines"], 1, "{body}");
        let (status, body) = call(&app, "POST", "/api/recorder/stop", "").await;
        assert_eq!(status, StatusCode::OK, "{body}");

        let bytes = std::fs::read(dir.join("full.mcap")).unwrap();
        let mut seen: Vec<(String, String, String, serde_json::Value)> = Vec::new();
        for message in mcap::MessageStream::new(&bytes).unwrap() {
            let message = message.unwrap();
            let schema = message.channel.schema.as_ref().map(|schema| schema.name.clone()).unwrap_or_default();
            seen.push((message.channel.topic.clone(), schema, message.channel.message_encoding.clone(), serde_json::from_slice(&message.data).unwrap()));
        }
        let on = |topic: &str| seen.iter().filter(|seen| seen.0 == topic).collect::<Vec<_>>();
        let logs = on("/dimos/logs/main");
        assert_eq!(logs.len(), 1);
        assert_eq!((logs[0].1.as_str(), logs[0].2.as_str()), ("foxglove.Log", "json"));
        assert_eq!(logs[0].3["message"], "went wrong");
        assert_eq!(logs[0].3["level"], 4);
        let labels: Vec<(String, String)> = on("/labels").iter().map(|seen| (seen.3["label"].as_str().unwrap().to_string(), seen.3["action"].as_str().unwrap().to_string())).collect();
        assert_eq!(labels, vec![("before".into(), "add".into()), ("during".into(), "add".into()), ("during".into(), "delete".into())]);
        assert!(on("/labels").iter().all(|seen| seen.1 == "dimos.LocationLabel" && seen.3["frame_id"] == "world"));
        let scene = on("/labels/scene");
        assert_eq!(scene.len(), 3);
        assert_eq!(scene[0].1, "foxglove.SceneUpdate");
        assert_eq!(scene[2].3["deletions"][0]["id"], id.as_str());
        // the log line keeps its own time, which is before this recording: mcap's summary still covers it
        let summary = mcap::Summary::read(&bytes).unwrap().unwrap();
        assert_eq!(summary.stats.unwrap().message_count, 7);
    }

    #[tokio::test]
    async fn settings_change_and_are_reported() {
        let app = crate::api::test_router(Arc::new(State::new(temp_dir("settings"), String::new())));
        let (status, body) = call(&app, "PUT", "/api/recorder/settings", r#"{"compression":"zstd","image_format":"png"}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["settings"]["compression"], "zstd");
        assert_eq!(body["settings"]["image_format"], "png");
    }
}

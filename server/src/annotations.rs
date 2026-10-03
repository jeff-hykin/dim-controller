//! Live annotations and the agent's view of the viewer. Annotations are ephemeral 3D boxes with labels (not zenoh
//! topics): kept here, pushed to every open page over the `GET /api/events/ws` websocket the moment they change. The page also answers
//! capture requests through that stream (its 3D view, the camera image, locating an object from an image box),
//! since only the page has the rendered view, the decoded clouds and the TF tree. `GET /agent.json` describes all of
//! it for Desktop's agent (dimos-desktop docs/agent.md).
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::extract::{Path, Query, State as Extract};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, oneshot};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Annotation {
    pub id: String,
    pub label: String,
    /// box center, meters in `frame`
    pub center: [f64; 3],
    /// full extents along the box's x, y, z
    pub size: [f64; 3],
    /// radians about +z
    #[serde(default)]
    pub yaw: f64,
    /// the TF frame it is in (default: the page's fixed frame, "world" in dimos)
    #[serde(default = "world")]
    pub frame: String,
    /// CSS color, e.g. "#ffd166"
    #[serde(default)]
    pub color: Option<String>,
    /// extra lines under the label, e.g. "1.76 m tall"
    #[serde(default)]
    pub note: Option<String>,
}

fn world() -> String {
    "world".into()
}

/// A page (a viewer tab) and when its user last looked at it.
#[derive(Clone, Debug, Serialize)]
struct Page {
    visible: bool,
    #[serde(rename = "lastActive")]
    last_active: u64,
}

pub struct Annotations {
    items: Mutex<BTreeMap<String, Annotation>>,
    next: AtomicU64,
    events: broadcast::Sender<Value>,
    pages: Mutex<HashMap<String, Page>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

impl Default for Annotations {
    fn default() -> Self {
        Annotations {
            items: Mutex::default(),
            next: AtomicU64::new(1),
            events: broadcast::channel(256).0,
            pages: Mutex::default(),
            pending: Mutex::default(),
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Fields an update may change; anything left out stays.
#[derive(Deserialize, Default)]
pub struct Patch {
    label: Option<String>,
    center: Option<[f64; 3]>,
    size: Option<[f64; 3]>,
    yaw: Option<f64>,
    frame: Option<String>,
    color: Option<String>,
    note: Option<String>,
    /// rename: the annotation's new id
    id: Option<String>,
}

impl Annotations {
    pub fn list(&self) -> Vec<Annotation> {
        self.items.lock().unwrap().values().cloned().collect()
    }

    /// Sends an event to every open page.
    pub fn broadcast(&self, event: Value) {
        let _ = self.events.send(event);
    }

    fn changed(&self) {
        let _ = self.events.send(json!({ "type": "annotations", "annotations": self.list() }));
    }

    /// Adds one; a missing id becomes "box-<n>", a taken id is an error.
    pub fn create(&self, mut annotation: Value) -> Result<Annotation, String> {
        if annotation.get("id").is_none_or(|id| id.as_str().is_none_or(str::is_empty)) {
            let items = self.items.lock().unwrap();
            let mut id = format!("box-{}", self.next.fetch_add(1, Ordering::Relaxed));
            while items.contains_key(&id) {
                id = format!("box-{}", self.next.fetch_add(1, Ordering::Relaxed));
            }
            annotation["id"] = json!(id);
        }
        if annotation.get("label").is_none() {
            annotation["label"] = json!("");
        }
        let annotation: Annotation = serde_json::from_value(annotation).map_err(|e| format!("bad annotation: {e}"))?;
        validate(&annotation)?;
        {
            let mut items = self.items.lock().unwrap();
            if items.contains_key(&annotation.id) {
                return Err(format!("id {} is taken (PATCH it instead)", annotation.id));
            }
            items.insert(annotation.id.clone(), annotation.clone());
        }
        self.changed();
        Ok(annotation)
    }

    pub fn update(&self, id: &str, patch: Patch) -> Result<Annotation, String> {
        let updated = {
            let mut items = self.items.lock().unwrap();
            let mut annotation = items.get(id).cloned().ok_or_else(|| format!("no annotation {id}"))?;
            if let Some(label) = patch.label {
                annotation.label = label;
            }
            if let Some(center) = patch.center {
                annotation.center = center;
            }
            if let Some(size) = patch.size {
                annotation.size = size;
            }
            if let Some(yaw) = patch.yaw {
                annotation.yaw = yaw;
            }
            if let Some(frame) = patch.frame {
                annotation.frame = frame;
            }
            if let Some(color) = patch.color {
                annotation.color = Some(color).filter(|c| !c.is_empty());
            }
            if let Some(note) = patch.note {
                annotation.note = Some(note).filter(|n| !n.is_empty());
            }
            if let Some(new_id) = patch.id.filter(|new_id| new_id != id) {
                if items.contains_key(&new_id) {
                    return Err(format!("id {new_id} is taken"));
                }
                annotation.id = new_id;
            }
            validate(&annotation)?;
            items.remove(id);
            items.insert(annotation.id.clone(), annotation.clone());
            annotation
        };
        self.changed();
        Ok(updated)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.items.lock().unwrap().remove(id).ok_or_else(|| format!("no annotation {id}"))?;
        self.changed();
        Ok(())
    }

    pub fn clear(&self) -> usize {
        let count = std::mem::take(&mut *self.items.lock().unwrap()).len();
        self.changed();
        count
    }

    /// The page the user looked at last (a visible one wins).
    fn active_page(&self) -> Option<String> {
        let pages = self.pages.lock().unwrap();
        pages.iter().max_by_key(|(_, page)| (page.visible, page.last_active)).map(|(id, _)| id.clone())
    }

    /// Asks the active page to do something only it can (render, read the camera, locate) and waits for its answer.
    pub async fn ask_page(&self, kind: &str, args: Value) -> Result<Value, String> {
        let page = self.active_page().ok_or("no Live Viewer page is open (open_app the Live Viewer first)")?;
        let request = format!("r{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(request.clone(), sender);
        let _ = self.events.send(json!({ "type": "capture", "page": page, "request": request, "kind": kind, "args": args }));
        let answer = tokio::time::timeout(Duration::from_secs(15), receiver).await;
        self.pending.lock().unwrap().remove(&request);
        match answer {
            Ok(Ok(value)) => match value.get("error").and_then(Value::as_str) {
                Some(error) => Err(error.to_string()),
                None => Ok(value),
            },
            _ => Err("the Live Viewer page didn't answer (is its tab open?)".into()),
        }
    }
}

fn validate(annotation: &Annotation) -> Result<(), String> {
    if annotation.id.is_empty() || annotation.id.len() > 64 || annotation.id.contains(['/', '?', '#']) {
        return Err("id: 1-64 characters, no / ? #".into());
    }
    if annotation.size.iter().any(|s| !s.is_finite() || *s <= 0.0) || annotation.center.iter().any(|c| !c.is_finite()) {
        return Err("center must be finite and size > 0".into());
    }
    Ok(())
}

fn error(status: StatusCode, message: impl std::fmt::Display) -> Response {
    (status, Json(json!({ "error": message.to_string() }))).into_response()
}

#[derive(Deserialize)]
struct PageQuery {
    page: Option<String>,
}

#[derive(Deserialize)]
struct PageReport {
    visible: bool,
    #[serde(default)]
    active: bool,
}

/// What Desktop's agent reads: the manifest of this app's endpoints.
pub fn manifest() -> Value {
    let vec3 = |what: &str| json!({ "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3, "description": what });
    let box_params = json!({
        "id": { "type": "string", "description": "optional id (default box-<n>); use it to update or delete" },
        "label": { "type": "string", "description": "shown above the box" },
        "center": vec3("box center [x, y, z], meters in frame"),
        "size": vec3("full extents [dx, dy, dz], meters"),
        "yaw": { "type": "number", "description": "radians about +z (default 0)" },
        "frame": { "type": "string", "description": "TF frame of center (default world)" },
        "color": { "type": "string", "description": "CSS color" },
        "note": { "type": "string", "description": "a second line under the label, e.g. \"1.76 m tall\"" }
    });
    json!({
        "description": "Live 3D view of the running robot (point clouds, camera, TF, map) with live 3D annotations: boxes with labels that every open viewer shows within a frame. Coordinates are meters in the world frame, +z up.",
        "endpoints": [
            { "method": "GET", "path": "api/view", "role": "view", "description": "What the user sees: the rendered 3D view (with annotation labels) as an image, the 3D camera's pose and intrinsics, the latest robot camera image (with a pixel grid) and its CameraInfo and pose, the annotations, and the fixed frame." },
            { "method": "POST", "path": "api/locate", "description": "Find an object in 3D from a box around it in the robot camera image (pixel coordinates of the image GET api/view returns): uses the lidar points inside that box (else where the box's bottom meets the floor) and returns its 3D box and height. add=true also adds it as an annotation.", "params": {
                "bbox": { "type": "array", "items": { "type": "number" }, "minItems": 4, "maxItems": 4, "description": "[x1, y1, x2, y2] pixels in the camera image", "required": true },
                "label": { "type": "string" }, "add": { "type": "boolean" }, "id": { "type": "string" } } },
            { "method": "GET", "path": "api/annotations", "role": "context", "description": "The live annotations (id, label, center, size, yaw, frame, note)." },
            { "method": "POST", "path": "api/annotations", "description": "Add a live 3D box annotation with a label; every open viewer shows it immediately.", "params": box_params },
            { "method": "PATCH", "path": "api/annotations/{id}", "description": "Change an annotation: label, note, center, size, yaw, color, or id (to rename it).", "params": {
                "id": { "type": "string", "description": "the annotation's id", "required": true },
                "label": { "type": "string" }, "note": { "type": "string" }, "center": vec3("new center"), "size": vec3("new size"),
                "yaw": { "type": "number" }, "color": { "type": "string" }, "newId": { "type": "string", "description": "rename to this id" } } },
            { "method": "DELETE", "path": "api/annotations/{id}", "description": "Remove an annotation by id.", "params": { "id": { "type": "string", "required": true } } },
            { "method": "DELETE", "path": "api/annotations", "description": "Remove every annotation." },
            { "method": "GET", "path": "api/labels", "role": "context", "description": "Location labels the user (or you) pinned in the map: id, label, frame_id, position, orientation, created (ns)." },
            { "method": "POST", "path": "api/labels", "description": "Pin a text label at a point (the viewer's fixed frame, usually world); if a recording is running it is written into it on /labels.", "params": {
                "label": { "type": "string", "required": true }, "frame_id": { "type": "string", "required": true, "description": "the frame of position, e.g. world" },
                "position": vec3("[x, y, z] meters in frame_id") } },
            { "method": "DELETE", "path": "api/labels/{id}", "description": "Remove a location label.", "params": { "id": { "type": "string", "required": true } } }
        ]
    })
}

/// One page's events: registers the page (forgotten when the stream is dropped), starts with the annotations, then
/// every broadcast event except capture requests meant for another page. Shared by the SSE and websocket routes.
fn page_events(annotations: Arc<Annotations>, page: String) -> impl futures_util::Stream<Item = Value> + Send + 'static {
    if !page.is_empty() {
        annotations.pages.lock().unwrap().insert(page.clone(), Page { visible: true, last_active: now_ms() });
    }
    let first = json!({ "type": "annotations", "annotations": annotations.list() });
    let receiver = annotations.events.subscribe();
    // dropped when the page's stream closes: forget the page
    struct Leave(Arc<Annotations>, String);
    impl Drop for Leave {
        fn drop(&mut self) {
            self.0.pages.lock().unwrap().remove(&self.1);
        }
    }
    let guard = Leave(annotations, page);
    futures_util::stream::unfold((Some(first), receiver, guard), |(first, mut receiver, guard)| async move {
        if let Some(first) = first {
            return Some((first, (None, receiver, guard)));
        }
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    // a capture request is for one page only
                    if event["type"] == "capture" && event["page"] != guard.1.as_str() {
                        continue;
                    }
                    return Some((event, (None, receiver, guard)));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return None,
            }
        }
    })
}

/// The old SSE stream, kept for compatibility; pages use `api/events/ws`.
async fn events(Extract(state): Extract<Arc<Annotations>>, Query(query): Query<PageQuery>) -> impl IntoResponse {
    let stream = page_events(state, query.page.unwrap_or_default())
        .map(|event| Ok::<_, std::convert::Infallible>(Event::default().data(event.to_string())));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// The standard backend → page channel (dim-app's events.js): the same events, one JSON text message each.
async fn events_ws(Extract(state): Extract<Arc<Annotations>>, Query(query): Query<PageQuery>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |mut socket| async move {
        let mut events = std::pin::pin!(page_events(state, query.page.unwrap_or_default()));
        loop {
            tokio::select! {
                event = events.next() => {
                    let Some(event) = event else {
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    };
                    if socket.send(Message::Text(event.to_string().into())).await.is_err() {
                        break;
                    }
                }
                incoming = socket.recv() => match incoming {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                },
            }
        }
    })
}

pub fn router(state: Arc<Annotations>) -> Router {
    Router::new()
        .route("/agent.json", get(|| async { Json(manifest()) }))
        .route("/api/events", get(events))
        .route("/api/events/ws", get(events_ws))
        .route(
            "/api/annotations",
            get(|Extract(state): Extract<Arc<Annotations>>| async move { Json(json!({ "annotations": state.list() })) })
                .post(|Extract(state): Extract<Arc<Annotations>>, Json(body): Json<Value>| async move {
                    match state.create(body) {
                        Ok(annotation) => Json(annotation).into_response(),
                        Err(problem) => error(StatusCode::BAD_REQUEST, problem),
                    }
                })
                .delete(|Extract(state): Extract<Arc<Annotations>>| async move { Json(json!({ "removed": state.clear() })) }),
        )
        .route(
            "/api/annotations/{id}",
            patch(|Extract(state): Extract<Arc<Annotations>>, Path(id): Path<String>, Json(body): Json<Value>| async move {
                let mut body = body;
                if let Some(new_id) = body.get("newId").cloned() {
                    body["id"] = new_id;
                } else if let Some(object) = body.as_object_mut() {
                    object.remove("id");
                }
                let patch: Patch = match serde_json::from_value(body) {
                    Ok(patch) => patch,
                    Err(problem) => return error(StatusCode::BAD_REQUEST, problem),
                };
                match state.update(&id, patch) {
                    Ok(annotation) => Json(annotation).into_response(),
                    Err(problem) => error(StatusCode::NOT_FOUND, problem),
                }
            })
            .delete(|Extract(state): Extract<Arc<Annotations>>, Path(id): Path<String>| async move {
                match state.delete(&id) {
                    Ok(()) => Json(json!({ "ok": true, "removed": id })).into_response(),
                    Err(problem) => error(StatusCode::NOT_FOUND, problem),
                }
            }),
        )
        .route(
            "/api/pages/{page}",
            post(|Extract(state): Extract<Arc<Annotations>>, Path(page): Path<String>, Json(report): Json<PageReport>| async move {
                let mut pages = state.pages.lock().unwrap();
                let entry = pages.entry(page).or_insert(Page { visible: report.visible, last_active: now_ms() });
                entry.visible = report.visible;
                if report.active {
                    entry.last_active = now_ms();
                }
                Json(json!({ "ok": true }))
            }),
        )
        .route(
            "/api/captures/{request}",
            post(|Extract(state): Extract<Arc<Annotations>>, Path(request): Path<String>, Json(body): Json<Value>| async move {
                match state.pending.lock().unwrap().remove(&request) {
                    Some(sender) => {
                        let _ = sender.send(body);
                        Json(json!({ "ok": true })).into_response()
                    }
                    None => error(StatusCode::NOT_FOUND, "no such capture request (timed out?)"),
                }
            }),
        )
        .route(
            "/api/view",
            get(|Extract(state): Extract<Arc<Annotations>>| async move {
                match state.ask_page("view", json!({})).await {
                    Ok(view) => Json(view).into_response(),
                    Err(problem) => error(StatusCode::SERVICE_UNAVAILABLE, problem),
                }
            }),
        )
        .route(
            "/api/locate",
            post(|Extract(state): Extract<Arc<Annotations>>, Json(body): Json<Value>| async move {
                let bbox_ok = body["bbox"].as_array().is_some_and(|b| b.len() == 4 && b.iter().all(Value::is_number));
                if !bbox_ok {
                    return error(StatusCode::BAD_REQUEST, "bbox: [x1, y1, x2, y2] in camera image pixels");
                }
                let found = match state.ask_page("locate", body.clone()).await {
                    Ok(found) => found,
                    Err(problem) => return error(StatusCode::UNPROCESSABLE_ENTITY, problem),
                };
                if body["add"].as_bool() != Some(true) {
                    return Json(found).into_response();
                }
                let mut annotation = found["box"].clone();
                annotation["label"] = body.get("label").cloned().unwrap_or(json!(""));
                if let Some(id) = body.get("id") {
                    annotation["id"] = id.clone();
                }
                match state.create(annotation) {
                    Ok(added) => Json(json!({ "located": found, "annotation": added })).into_response(),
                    Err(problem) => error(StatusCode::BAD_REQUEST, problem),
                }
            }),
        )
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_update_rename_delete() {
        let annotations = Annotations::default();
        let mut events = annotations.events.subscribe();
        let first = annotations.create(json!({ "label": "person", "center": [1, 2, 0.9], "size": [0.6, 0.5, 1.8] })).unwrap();
        assert_eq!(first.id, "box-1");
        assert_eq!(first.frame, "world");
        let event = events.try_recv().unwrap();
        assert_eq!(event["annotations"][0]["label"], "person");
        assert!(annotations.create(json!({ "id": "box-1", "center": [0, 0, 0], "size": [1, 1, 1] })).is_err());
        assert!(annotations.create(json!({ "center": [0, 0, 0], "size": [0, 1, 1] })).is_err());
        let patched = annotations.update("box-1", Patch { note: Some("1.76 m tall".into()), ..Default::default() }).unwrap();
        assert_eq!(patched.note.as_deref(), Some("1.76 m tall"));
        let renamed = annotations.update("box-1", Patch { id: Some("person-1".into()), label: Some("Jeong".into()), ..Default::default() }).unwrap();
        assert_eq!((renamed.id.as_str(), renamed.label.as_str()), ("person-1", "Jeong"));
        assert_eq!(annotations.list().len(), 1);
        assert!(annotations.delete("box-1").is_err());
        annotations.delete("person-1").unwrap();
        assert!(annotations.list().is_empty());
    }

    #[test]
    fn manifest_has_a_view_and_crud() {
        let manifest = manifest();
        let endpoints = manifest["endpoints"].as_array().unwrap();
        assert!(endpoints.iter().any(|e| e["role"] == "view" && e["path"] == "api/view"));
        for method in ["GET", "POST", "PATCH", "DELETE"] {
            assert!(endpoints.iter().any(|e| e["method"] == method && e["path"].as_str().unwrap().starts_with("api/annotations")), "{method}");
        }
    }

    #[tokio::test]
    async fn the_active_page_answers_captures() {
        let annotations = Arc::new(Annotations::default());
        assert!(annotations.ask_page("view", json!({})).await.is_err());
        annotations.pages.lock().unwrap().insert("p1".into(), Page { visible: true, last_active: 1 });
        annotations.pages.lock().unwrap().insert("p2".into(), Page { visible: true, last_active: 2 });
        let mut events = annotations.events.subscribe();
        let asking = annotations.clone();
        let task = tokio::spawn(async move { asking.ask_page("view", json!({})).await });
        let request = events.recv().await.unwrap();
        assert_eq!(request["page"], "p2");
        let sender = annotations.pending.lock().unwrap().remove(request["request"].as_str().unwrap()).unwrap();
        sender.send(json!({ "camera": { "fov": 60 } })).unwrap();
        assert_eq!(task.await.unwrap().unwrap()["camera"]["fov"], 60);
    }

    /// The websocket route over a real socket: registers the page, sends the annotations first, then each change and
    /// only this page's captures, one JSON text message each; the page is forgotten when the socket closes.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_websocket_carries_this_pages_events() {
        use tokio_tungstenite::tungstenite::Message as Frame;
        let annotations = Arc::new(Annotations::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = router(annotations.clone());
        tokio::spawn(async move { axum::serve(listener, app).await });
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/api/events/ws?page=p1")).await.unwrap();
        let mut next = async || loop {
            match socket.next().await.unwrap().unwrap() {
                Frame::Text(text) => return serde_json::from_str::<Value>(&text).unwrap(),
                _ => continue,
            }
        };
        assert_eq!(next().await["type"], "annotations");
        assert!(annotations.pages.lock().unwrap().contains_key("p1"));
        annotations.create(json!({ "label": "chair", "center": [0, 0, 0], "size": [1, 1, 1] })).unwrap();
        assert_eq!(next().await["annotations"][0]["label"], "chair");
        let _ = annotations.events.send(json!({ "type": "capture", "page": "p2", "request": "r1" }));
        let _ = annotations.events.send(json!({ "type": "capture", "page": "p1", "request": "r2" }));
        assert_eq!(next().await["request"], "r2");
        socket.close(None).await.unwrap();
        for _ in 0..50 {
            if !annotations.pages.lock().unwrap().contains_key("p1") {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the page outlived its socket");
    }
}

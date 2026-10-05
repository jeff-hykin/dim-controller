//! Controller's `dimos-app-server` (dimOS Desktop app contract, docs/apps.md in dimos-desktop): serves the built
//! page and every action as an HTTP endpoint (api.rs, listed at /agent.json): an mcap recorder that subscribes to
//! dimos topics over zenoh while a recording runs, location labels, live annotations, the agent's view of the page,
//! the page's settings, the camera and driving.

mod annotations;
mod api;
mod cdr;
mod desktop;
mod dimos_app;
mod drive;
mod image;
mod labels;
mod logs;
mod msgs;
mod record;
mod recorder;
mod routes;
mod settings;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;

#[derive(Parser, Debug, Clone)]
#[command(about = "Controller backend: the page, driving, and an mcap recorder")]
pub struct Args {
    /// serve HTTP on this unix socket (Desktop passes it in DIMOS_APP; these flags and env vars are the older
    /// Desktops' way, and DIMOS_APP wins over them)
    #[arg(long, env = "DIMOS_APP_SOCKET")]
    socket: Option<PathBuf>,
    /// serve HTTP on this TCP port instead (development)
    #[arg(long)]
    port: Option<u16>,
    #[arg(long, env = "DIMOS_DESKTOP_URL", default_value = "")]
    desktop_url: String,
    #[arg(long, env = "ZENOH_WEB_URL", default_value = "")]
    zenoh_web_url: String,
    /// the zenoh endpoint dimos modules are on; empty = join the local network as a peer
    #[arg(long, env = "ZENOH_CONNECT", default_value = "")]
    zenoh_connect: String,
    #[arg(long, env = "DIMOS_DIR", default_value = "")]
    dimos_dir: String,
    #[arg(long, env = "DIMOS_PYTHON", default_value = "")]
    dimos_python: String,
    /// the built page (vite's dist); the nix wrapper sets it
    #[arg(long, env = "CONTROLLER_FRONTEND")]
    frontend: Option<PathBuf>,
    /// where recordings go [default: Desktop's shared folder $DIMOS_RECORDINGS_DIR/controller (or its live-viewer
    /// folder, if this app made one before it was renamed), else $DIMOS_APP_DATA/recordings]
    #[arg(long, env = "CONTROLLER_RECORD_DIR")]
    record_dir: Option<PathBuf>,
    /// print the endpoints (agent.json) and exit: scripts/check_endpoints.ts compares them with dimos.yaml
    #[arg(long)]
    agent_json: bool,
}

/// The app's name before it was renamed: its data dir and recordings folder are still used (see `default_record_dir`,
/// `settings_file`), so nothing a user made is lost.
const OLD_APP_NAME: &str = "dim-live-viewer";

/// Where recordings go when nobody says: Desktop's shared recordings folder (where other apps find them), else the
/// app's data dir, never the app's own (git) checkout. A `live-viewer` folder from before the rename stays in use.
fn default_record_dir() -> PathBuf {
    if let Some(dir) = dimos_app::field(|app| app.recordings_dir.as_ref(), "DIMOS_RECORDINGS_DIR") {
        let old = PathBuf::from(&dir).join("live-viewer");
        return if old.is_dir() { old } else { PathBuf::from(dir).join("controller") };
    }
    if let Some(data) = app_data() {
        let old = data.parent().map(|apps| apps.join(OLD_APP_NAME).join("recordings")).filter(|old| old.is_dir());
        return match old {
            Some(old) if !data.join("recordings").is_dir() => old,
            _ => data.join("recordings"),
        };
    }
    let home = std::env::var("DIMOS_HOME").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".dimos")
    });
    let app = dimos_app::field(|app| app.name.as_ref(), "DIMOS_APP_NAME").unwrap_or_else(|| "dim-controller".into());
    home.join("data").join(app).join("recordings")
}

fn app_data() -> Option<PathBuf> {
    dimos_app::field(|app| app.data_dir.as_ref(), "DIMOS_APP_DATA").map(PathBuf::from)
}

/// `settings.json` in the app's data dir. Installed under its new name, the app starts from the settings it had under
/// the old one (a copy: the old install, if still there, keeps its own).
fn settings_file() -> Option<PathBuf> {
    let data = app_data()?;
    let file = data.join("settings.json");
    let old = data.parent().map(|apps| apps.join(OLD_APP_NAME).join("settings.json"));
    if let Some(old) = old.filter(|old| !file.exists() && old.is_file() && *old != file) {
        let _ = std::fs::create_dir_all(&data);
        if std::fs::copy(&old, &file).is_ok() {
            eprintln!("controller: settings carried over from {}", old.display());
        }
    }
    Some(file)
}

/// The page itself is always revalidated: it names the hashed assets of its build, and the nix store's 1970 mtimes
/// otherwise let a browser keep an old page (and the old app) for good after an update.
async fn revalidate_html(mut response: axum::response::Response) -> axum::response::Response {
    let html = response.headers().get(axum::http::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with("text/html"));
    if html {
        response.headers_mut().insert(axum::http::header::CACHE_CONTROL, axum::http::HeaderValue::from_static("no-cache"));
    }
    response
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = Args::parse();
    if let Some(app) = dimos_app::get() {
        let set = |to: &mut String, from: &Option<String>| {
            if let Some(value) = from {
                *to = value.clone();
            }
        };
        if let Some(socket) = &app.socket {
            args.socket = Some(PathBuf::from(socket));
        }
        set(&mut args.desktop_url, &app.desktop_url);
        set(&mut args.zenoh_web_url, &app.zenoh_web_url);
        set(&mut args.zenoh_connect, &app.zenoh_connect);
        set(&mut args.dimos_dir, &app.dimos_dir);
        set(&mut args.dimos_python, &app.dimos_python);
    }
    if args.agent_json {
        println!("{}", serde_json::to_string_pretty(&api::routes().manifest(api::DESCRIPTION))?);
        return Ok(());
    }
    let record_dir = args.record_dir.clone().unwrap_or_else(default_record_dir);
    let frontend = args.frontend.clone().unwrap_or_else(|| PathBuf::from("frontend/dist"));
    eprintln!("controller: page {}, recordings {}", frontend.display(), record_dir.display());
    let state = Arc::new(recorder::State::new(record_dir, args.zenoh_connect.clone()));
    let settings_file = settings_file();
    let api = api::Api {
        recorder: state.clone(),
        annotations: Arc::default(),
        settings: Arc::new(settings::Settings::load(settings_file)),
        drive: Arc::default(),
        desktop_url: Arc::new(args.desktop_url.clone()),
    };
    let app = api::routes()
        .router
        .with_state(api)
        .fallback_service(tower_http::services::ServeDir::new(&frontend).fallback(tower_http::services::ServeFile::new(frontend.join("index.html"))))
        .layer(axum::middleware::map_response(revalidate_html));
    // Desktop stops an app server with SIGTERM to its process group
    let shutdown = async {
        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    };
    if let Some(port) = args.port {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.with_context(|| format!("bind :{port}"))?;
        eprintln!("controller: http://127.0.0.1:{port}/");
        axum::serve(listener, app).with_graceful_shutdown(shutdown).await?;
    } else {
        let socket = args.socket.clone().context("--socket or --port is required")?;
        let _ = std::fs::remove_file(&socket);
        let listener = tokio::net::UnixListener::bind(&socket).with_context(|| format!("bind {}", socket.display()))?;
        axum::serve(listener, app).with_graceful_shutdown(shutdown).await?;
    }
    // a recording in progress is closed cleanly so the file has its summary
    state.stop().await.ok();
    Ok(())
}

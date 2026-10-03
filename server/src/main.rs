//! Live Viewer's `dimos-app-server` (dimOS Desktop app contract, docs/apps.md in dimos-desktop): serves the built
//! page and every action as an HTTP endpoint (api.rs, listed at /agent.json): an mcap recorder that subscribes to
//! dimos topics over zenoh while a recording runs, location labels, live annotations, the agent's view of the page,
//! the page's settings, the camera and driving.

mod annotations;
mod api;
mod cdr;
mod desktop;
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
#[command(about = "Live Viewer backend: the page plus an mcap recorder")]
pub struct Args {
    /// serve HTTP on this unix socket (Desktop passes it)
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
    #[arg(long, env = "LIVE_VIEWER_FRONTEND")]
    frontend: Option<PathBuf>,
    /// where recordings go [default: Desktop's shared folder $DIMOS_RECORDINGS_DIR/live-viewer, else $DIMOS_APP_DATA/recordings]
    #[arg(long, env = "LIVE_VIEWER_RECORD_DIR")]
    record_dir: Option<PathBuf>,
    /// print the endpoints (agent.json) and exit: scripts/check_endpoints.ts compares them with dimos.yaml
    #[arg(long)]
    agent_json: bool,
}

/// Where recordings go when nobody says: Desktop's shared recordings folder (where other apps find them), else the
/// app's data dir, never the app's own (git) checkout.
fn default_record_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("DIMOS_RECORDINGS_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("live-viewer");
        }
    }
    if let Ok(dir) = std::env::var("DIMOS_APP_DATA") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("recordings");
        }
    }
    let home = std::env::var("DIMOS_HOME").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".dimos")
    });
    let app = std::env::var("DIMOS_APP_NAME").unwrap_or_else(|_| "dim-live-viewer".into());
    home.join("data").join(app).join("recordings")
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    if args.agent_json {
        println!("{}", serde_json::to_string_pretty(&api::routes().manifest(api::DESCRIPTION))?);
        return Ok(());
    }
    let record_dir = args.record_dir.clone().unwrap_or_else(default_record_dir);
    let frontend = args.frontend.clone().unwrap_or_else(|| PathBuf::from("frontend/dist"));
    eprintln!("live viewer: page {}, recordings {}", frontend.display(), record_dir.display());
    let state = Arc::new(recorder::State::new(record_dir, args.zenoh_connect.clone()));
    let settings_file = std::env::var("DIMOS_APP_DATA").ok().filter(|dir| !dir.is_empty()).map(|dir| PathBuf::from(dir).join("settings.json"));
    let api = api::Api {
        recorder: state.clone(),
        annotations: Arc::default(),
        settings: Arc::new(settings::Settings::load(settings_file)),
        drive: Arc::default(),
        desktop_url: Arc::new(args.desktop_url.clone()),
    };
    let app = api::routes().router.with_state(api).fallback_service(
        tower_http::services::ServeDir::new(&frontend).fallback(tower_http::services::ServeFile::new(frontend.join("index.html"))),
    );
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
        eprintln!("live viewer: http://127.0.0.1:{port}/");
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

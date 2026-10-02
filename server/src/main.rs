//! Live Viewer's `dimos-app-server` (dimOS Desktop app contract, docs/apps.md in dimos-desktop): serves the built
//! page and an mcap recorder that subscribes to the chosen dimos topics over zenoh while a recording runs.

mod cdr;
mod image;
mod msgs;
mod record;
mod recorder;

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
    /// where recordings go [default: $DIMOS_APP_DATA/recordings, else ~/.dimos/data/<app>/recordings]
    #[arg(long, env = "LIVE_VIEWER_RECORD_DIR")]
    record_dir: Option<PathBuf>,
}

/// Where recordings go when nobody says: the app's data dir from Desktop, never the app's own (git) checkout.
fn default_record_dir() -> PathBuf {
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
    let record_dir = args.record_dir.clone().unwrap_or_else(default_record_dir);
    let frontend = args.frontend.clone().unwrap_or_else(|| PathBuf::from("frontend/dist"));
    eprintln!("live viewer: page {}, recordings {}", frontend.display(), record_dir.display());
    let state = Arc::new(recorder::State::new(record_dir, args.zenoh_connect.clone()));
    let app = recorder::router(state.clone()).fallback_service(
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

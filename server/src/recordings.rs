//! Where recordings live. The dimos gateway's `GET /gateways/dimos/history/recordings` answers `{path}` and is the one
//! authority on the folder; DIMOS_APP's `recordingsDir` is what Desktop said when the app started, the answer for when
//! the gateway can't be reached. Asked once, at the start (main.rs), and remembered, so the recorder panel names the
//! same folder the recorder writes to.

use std::sync::OnceLock;
use std::time::Duration;

/// How long the gateway gets to answer: the app's socket is waiting on this (main.rs asks before it serves), and what
/// Desktop said at the start is right there to fall back on, so it's far shorter than desktop.rs's own 30 s.
const ASK: Duration = Duration::from_secs(3);

static ROOT: OnceLock<Option<String>> = OnceLock::new();

/// Ask the gateway (then fall back to what Desktop said) and remember the answer; later calls return it. None when
/// neither said, which outside Desktop is the usual case.
pub async fn ask() -> Option<String> {
    if let Some(root) = ROOT.get() {
        return root.clone();
    }
    let desktop = crate::dimos_app::field(|app| app.desktop_url.as_ref()).unwrap_or_default();
    let root = match gateway(&desktop).await {
        Some(path) => Some(path),
        None => crate::dimos_app::field(|app| app.recordings_dir.as_ref()),
    };
    ROOT.get_or_init(|| root).clone()
}

/// The folder found at the start, None before `ask` (and when nobody said).
pub fn root() -> Option<String> {
    ROOT.get().cloned().flatten()
}

/// What the dimos gateway says, None when there's no Desktop to ask (`base` empty) or it couldn't say.
async fn gateway(base: &str) -> Option<String> {
    if base.is_empty() {
        return None;
    }
    let asked = crate::desktop::get(base, "/gateways/dimos/history/recordings");
    let answer = match tokio::time::timeout(ASK, asked).await {
        Ok(answer) => answer.map_err(|error| error.to_string()),
        Err(_) => Err("it didn't answer".to_string()),
    };
    match answer {
        Ok(answer) => answer["path"]
            .as_str()
            .filter(|path| !path.is_empty())
            .map(str::to_string),
        Err(error) => {
            eprintln!("controller: the dimos gateway didn't say where recordings go ({error}); using what Desktop said at the start");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn the_gateways_folder_or_nothing() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 1024];
            let _ = socket.read(&mut buffer).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 24\r\n\r\n{\"path\":\"/r/recordings\"}")
                .await
                .unwrap();
        });
        assert_eq!(
            gateway(&format!("http://{address}")).await.as_deref(),
            Some("/r/recordings")
        );
        // nothing to ask (outside Desktop), and a gateway that isn't there: the caller falls back
        assert_eq!(gateway("").await, None);
        assert_eq!(gateway("http://127.0.0.1:9").await, None);
        assert_eq!(root(), None);
    }
}

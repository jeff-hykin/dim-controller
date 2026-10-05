//! Driving from an endpoint (the agent's way; the page's keys and stick publish through the bridge at 20 Hz with the
//! bridge's deadman): a Twist on `dimos/<topic>/geometry_msgs.Twist` at 10 Hz for a few seconds, then a second of
//! zeros so the stop is heard. `dryRun` says what would be sent and sends nothing. A new command or a stop replaces
//! the one running. There is no arming (since 2026-10-05): commands always go out (api/drive/arm is a no-op).
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::msgs::{encode_twist, TWIST_TYPE};
use crate::recorder;

pub const MAX_SECONDS: f64 = 10.0;
const HZ: u64 = 10;

#[derive(Default)]
pub struct Drive {
    /// bumped by every command: a running one stops when it no longer matches
    generation: AtomicU64,
    /// the running command (what `send` described, plus source and `until`, ms since the epoch)
    running: Mutex<Option<Value>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct Command {
    pub topic: String,
    pub linear: [f64; 3],
    pub angular: [f64; 3],
    pub seconds: f64,
}

fn vector(value: &Value, name: &str) -> Result<[f64; 3], String> {
    match value {
        Value::Null => Ok([0.0; 3]),
        other => {
            let v: [f64; 3] =
                serde_json::from_value(other.clone()).map_err(|_| format!("{name}: [x, y, z]"))?;
            if v.iter().all(|x| x.is_finite() && x.abs() <= 5.0) {
                Ok(v)
            } else {
                Err(format!("{name}: each part within ±5"))
            }
        }
    }
}

/// A command from a request body; `topic` falls back to `default_topic`.
pub fn parse(body: &Value, default_topic: &str) -> Result<Command, String> {
    let seconds = body["seconds"].as_f64().unwrap_or(1.0);
    if !(seconds > 0.0 && seconds <= MAX_SECONDS) {
        return Err(format!("seconds: more than 0, at most {MAX_SECONDS}"));
    }
    let topic = body["topic"]
        .as_str()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or(default_topic);
    let topic = format!("/{}", topic.trim().trim_start_matches('/'));
    if topic.len() < 2 || topic.contains(['*', '$', '?', '#']) {
        return Err("topic: a dimos topic like /cmd_vel".into());
    }
    Ok(Command {
        topic,
        linear: vector(&body["linear"], "linear")?,
        angular: vector(&body["angular"], "angular")?,
        seconds,
    })
}

pub fn key(topic: &str) -> String {
    format!("dimos/{}/{TWIST_TYPE}", topic.trim_start_matches('/'))
}

impl Drive {
    /// The command being sent now, if any.
    pub fn running(&self) -> Option<Value> {
        let mut running = self.running.lock().unwrap();
        if running
            .as_ref()
            .is_some_and(|command| command["until"].as_u64().unwrap_or(0) < now_ms())
        {
            *running = None;
        }
        running.clone()
    }

    /// Starts sending `command` (replacing any running one); returns what it sends.
    pub fn send(
        self: &Arc<Self>,
        recorder: Arc<recorder::State>,
        command: Command,
        dry_run: bool,
    ) -> Value {
        let described = json!({
            "key": key(&command.topic),
            "linear": command.linear,
            "angular": command.angular,
            "seconds": command.seconds,
            "hz": HZ,
            "messages": (command.seconds * HZ as f64).ceil() as u64 + HZ,
            "dryRun": dry_run,
        });
        if dry_run {
            return described;
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let moving = command
            .linear
            .iter()
            .chain(&command.angular)
            .any(|v| *v != 0.0);
        *self.running.lock().unwrap() = moving.then(|| {
            let mut running = described.clone();
            running["until"] = json!(now_ms() + (command.seconds * 1000.0) as u64);
            running
        });
        let drive = self.clone();
        tokio::spawn(async move {
            let Ok(session) = recorder.session().await else {
                return;
            };
            let key = key(&command.topic);
            let moving = encode_twist(command.linear, command.angular);
            let zero = encode_twist([0.0; 3], [0.0; 3]);
            let ticks = (command.seconds * HZ as f64).ceil() as u64;
            for tick in 0..ticks + HZ {
                // a newer command or a stop took over: it sends its own zeros
                if drive.generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                let payload = if tick < ticks {
                    moving.clone()
                } else {
                    zero.clone()
                };
                let _ = session.put(key.clone(), payload).await;
                tokio::time::sleep(Duration::from_millis(1000 / HZ)).await;
            }
        });
        described
    }

    /// Stops any running command and sends a second of zeros on `topic`.
    pub fn stop(
        self: &Arc<Self>,
        recorder: Arc<recorder::State>,
        topic: &str,
        dry_run: bool,
    ) -> Value {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if !dry_run {
            *self.running.lock().unwrap() = None;
        }
        let command = Command {
            topic: topic.to_string(),
            linear: [0.0; 3],
            angular: [0.0; 3],
            seconds: 0.1,
        };
        self.send(recorder, command, dry_run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_are_checked() {
        let command = parse(&json!({ "linear": [0.3, 0, 0], "seconds": 2 }), "/cmd_vel").unwrap();
        assert_eq!(
            (command.topic.as_str(), command.linear, command.seconds),
            ("/cmd_vel", [0.3, 0.0, 0.0], 2.0)
        );
        assert_eq!(
            parse(&json!({ "topic": "tele_cmd_vel" }), "/cmd_vel")
                .unwrap()
                .topic,
            "/tele_cmd_vel"
        );
        assert!(parse(&json!({ "seconds": 60 }), "/cmd_vel").is_err());
        assert!(parse(&json!({ "linear": [9, 0, 0] }), "/cmd_vel").is_err());
        assert!(parse(&json!({ "linear": "fast" }), "/cmd_vel").is_err());
        assert!(parse(&json!({ "topic": "dimos/**" }), "/cmd_vel").is_err());
        assert_eq!(key("/cmd_vel"), "dimos/cmd_vel/geometry_msgs.Twist");
    }

    #[test]
    fn running() {
        let drive = Drive::default();
        *drive.running.lock().unwrap() = Some(json!({ "until": now_ms() + 5000 }));
        assert!(drive.running().is_some());
        *drive.running.lock().unwrap() = Some(json!({ "until": 1 }));
        assert!(
            drive.running().is_none(),
            "a finished command isn't running"
        );
    }

    /// a real zenoh round trip on loopback: the twist arrives, then zeros
    #[tokio::test(flavor = "multi_thread")]
    async fn publishes_then_stops() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut config = zenoh::Config::default();
        config
            .insert_json5("listen/endpoints", &format!(r#"["tcp/127.0.0.1:{port}"]"#))
            .unwrap();
        config
            .insert_json5("scouting/multicast/enabled", "false")
            .unwrap();
        let robot = zenoh::open(config).await.unwrap();
        let heard = Arc::new(std::sync::Mutex::new(Vec::<Vec<u8>>::new()));
        let sink = heard.clone();
        let _subscriber = robot
            .declare_subscriber("dimos/test_drive/geometry_msgs.Twist")
            .callback(move |s| sink.lock().unwrap().push(s.payload().to_bytes().to_vec()))
            .await
            .unwrap();
        let recorder = Arc::new(recorder::State::new(
            std::env::temp_dir(),
            format!("tcp/127.0.0.1:{port}"),
        ));
        recorder.session().await.unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let drive = Arc::new(Drive::default());
        let dry = drive.send(
            recorder.clone(),
            parse(
                &json!({ "topic": "/test_drive", "linear": [0.2, 0, 0], "seconds": 0.3 }),
                "",
            )
            .unwrap(),
            true,
        );
        assert_eq!(dry["dryRun"], true);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(heard.lock().unwrap().is_empty(), "a dry run sends nothing");
        drive.send(
            recorder.clone(),
            parse(
                &json!({ "topic": "/test_drive", "linear": [0.2, 0, 0], "seconds": 0.3 }),
                "",
            )
            .unwrap(),
            false,
        );
        tokio::time::sleep(Duration::from_millis(1800)).await;
        let heard = heard.lock().unwrap();
        assert!(heard.len() >= 8, "{} messages", heard.len());
        assert_eq!(heard[0], encode_twist([0.2, 0.0, 0.0], [0.0; 3]));
        assert_eq!(heard.last().unwrap(), &encode_twist([0.0; 3], [0.0; 3]));
    }
}

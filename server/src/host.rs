//! The machine the backend runs on (the robot's computer): its CPU load, sampled every SAMPLE_SECS in the background
//! (Linux: one small file read; macOS: one kernel call), so serving it costs nothing. The page's CPU chip polls it.
//! It also says whether that machine is a Steam Deck or runs SteamOS (the page's Steam Deck banner), and its network:
//! the IP it reaches the network from and its WiFi signal (the Network modal; Linux: /proc/net/wireless, macOS:
//! system_profiler), read in the background every WIFI_SECS.
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

const SAMPLE_SECS: u64 = 5;
/** the WiFi reading is reused this long (macOS's system_profiler takes about a second) */
const WIFI_SECS: u64 = 30;

#[derive(Clone, Copy)]
struct Sample {
    /// percent of all cores busy over the last SAMPLE_SECS
    busy_percent: f64,
    /// unix ms
    at: u128,
}

static CPU: Mutex<Option<Sample>> = Mutex::new(None);

pub fn spawn() {
    tokio::spawn(async move {
        loop {
            let reading = wifi_now().await;
            *WIFI.lock().unwrap() = reading;
            tokio::time::sleep(Duration::from_secs(WIFI_SECS)).await;
        }
    });
    tokio::spawn(async move {
        let mut previous = cpu_times();
        loop {
            tokio::time::sleep(Duration::from_secs(SAMPLE_SECS)).await;
            let current = cpu_times();
            // a counter that went backwards (macOS's 32-bit ticks wrap) skips that sample
            if let (Some((busy0, total0)), Some((busy1, total1))) = (previous, current) {
                if total1 > total0 && busy1 >= busy0 {
                    let busy_percent = 100.0 * (busy1 - busy0) as f64 / (total1 - total0) as f64;
                    let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                    *CPU.lock().unwrap() = Some(Sample { busy_percent, at });
                }
            }
            previous = current;
        }
    });
}

/// Linux (x86 and ARM alike): /proc/stat's first line, every core's (busy jiffies, all jiffies)
#[cfg(target_os = "linux")]
fn cpu_times() -> Option<(u64, u64)> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    let fields: Vec<u64> = stat.lines().next()?.split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
    // user nice system idle iowait irq softirq steal (guest time is already inside user)
    let total: u64 = fields.iter().take(8).sum();
    let idle = fields.get(3)? + fields.get(4).unwrap_or(&0);
    Some((total - idle, total))
}

#[cfg(target_os = "macos")]
extern "C" {
    fn mach_host_self() -> u32;
    fn host_statistics(host: u32, flavor: i32, info: *mut u32, count: *mut u32) -> i32;
}

/// macOS: the kernel's CPU ticks summed over every core (HOST_CPU_LOAD_INFO: user, system, idle, nice)
#[cfg(target_os = "macos")]
fn cpu_times() -> Option<(u64, u64)> {
    const HOST_CPU_LOAD_INFO: i32 = 3;
    static HOST: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    // SAFETY: mach_host_self takes nothing; asked once, as each call adds a reference to the port
    let host = *HOST.get_or_init(|| unsafe { mach_host_self() });
    let mut ticks = [0u32; 4];
    let mut count = ticks.len() as u32;
    // SAFETY: the buffer holds `count` naturals, which host_statistics fills at most
    let status = unsafe { host_statistics(host, HOST_CPU_LOAD_INFO, ticks.as_mut_ptr(), &mut count) };
    if status != 0 {
        return None;
    }
    let [user, system, idle, nice] = ticks.map(u64::from);
    Some((user + system + nice, user + system + idle + nice))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn cpu_times() -> Option<(u64, u64)> {
    None
}

/// (steamDeck, steamOs) under `root`: Valve's Jupiter (LCD) or Galileo (OLED) board; /etc/os-release's ID=steamos
fn steam_in(root: &std::path::Path) -> (bool, bool) {
    let read = |path: &str| std::fs::read_to_string(root.join(path)).unwrap_or_default().trim().to_string();
    let valve = ["sys/class/dmi/id/sys_vendor", "sys/class/dmi/id/board_vendor"].iter().any(|file| read(file) == "Valve");
    let deck = valve && matches!(read("sys/class/dmi/id/product_name").as_str(), "Jupiter" | "Galileo");
    let steam_os = read("etc/os-release").lines().any(|line| matches!(line.trim(), "ID=steamos" | "ID=\"steamos\""));
    (deck, steam_os)
}

/// The WiFi interface and its signal (dBm) from /proc/net/wireless: the strongest interface listed.
fn parse_proc_wireless(text: &str) -> Option<(String, f64)> {
    text.lines()
        .skip(2)
        .filter_map(|line| {
            let (name, rest) = line.split_once(':')?;
            // status, link quality, level (dBm; "-56." with a dot), noise, ...
            let level: f64 = rest.split_whitespace().nth(2)?.trim_end_matches('.').parse().ok()?;
            Some((name.trim().to_string(), level))
        })
        .filter(|(_, level)| *level < 0.0)
        .max_by(|a, b| a.1.total_cmp(&b.1))
}

/// The WiFi interface and its signal (dBm) from `system_profiler SPAirPortDataType -json` (the network's name is
/// redacted by macOS).
fn parse_airport(json: &serde_json::Value) -> Option<(String, f64)> {
    json["SPAirPortDataType"].as_array()?.iter().find_map(|entry| {
        entry["spairport_airport_interfaces"].as_array()?.iter().find_map(|interface| {
            let signal = interface["spairport_current_network_information"]["spairport_signal_noise"].as_str()?;
            let dbm: f64 = signal.split_whitespace().next()?.parse().ok()?;
            Some((interface["_name"].as_str().unwrap_or("wifi").to_string(), dbm))
        })
    })
}

async fn wifi_now() -> Option<(String, f64)> {
    if cfg!(target_os = "linux") {
        return parse_proc_wireless(&tokio::fs::read_to_string("/proc/net/wireless").await.ok()?);
    }
    if cfg!(target_os = "macos") {
        // system_profiler can take several seconds: this runs in the background, never under a request
        let output = tokio::time::timeout(
            Duration::from_secs(30),
            tokio::process::Command::new("system_profiler").args(["SPAirPortDataType", "-json"]).kill_on_drop(true).output(),
        )
        .await
        .ok()?
        .ok()?;
        return parse_airport(&serde_json::from_slice(&output.stdout).ok()?);
    }
    None
}

/// the latest WiFi reading, refreshed every WIFI_SECS in the background (spawn)
static WIFI: Mutex<Option<(String, f64)>> = Mutex::new(None);

/// The address this machine reaches the network from (the route to a public address; a UDP connect sends nothing).
fn local_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}

pub async fn get() -> Response {
    static STEAM: std::sync::OnceLock<(bool, bool)> = std::sync::OnceLock::new();
    let (steam_deck, steam_os) = *STEAM.get_or_init(|| steam_in(std::path::Path::new("/")));
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let sample = *CPU.lock().unwrap();
    Json(json!({
        "cpu": sample.map(|s| json!({ "busyPercent": (s.busy_percent * 10.0).round() / 10.0, "cores": cores, "sampledAt": s.at, "everySecs": SAMPLE_SECS })),
        "steamDeck": steam_deck,
        "steamOs": steam_os,
        "ip": local_ip(),
        "wifi": WIFI.lock().unwrap().clone().map(|(interface, dbm)| json!({ "interface": interface, "signalDbm": dbm })),
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::{parse_airport, parse_proc_wireless, steam_in};

    #[test]
    fn wifi_signal_from_linux_and_macos() {
        let proc = "Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE\n face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22\n wlan0: 0000   54.  -56.  -256        0      0      0      0     12        0\n";
        assert_eq!(parse_proc_wireless(proc), Some(("wlan0".to_string(), -56.0)));
        assert_eq!(parse_proc_wireless("header\nheader\n"), None);
        let airport = serde_json::json!({ "SPAirPortDataType": [{ "spairport_airport_interfaces": [
            { "_name": "en0", "spairport_current_network_information": { "_name": "<redacted>", "spairport_signal_noise": "-61 dBm / -95 dBm" } },
            { "_name": "awdl0" },
        ] }] });
        assert_eq!(parse_airport(&airport), Some(("en0".to_string(), -61.0)));
        assert_eq!(parse_airport(&serde_json::json!({})), None);
    }

    #[test]
    fn steam_deck_and_steamos() {
        let root = std::env::temp_dir().join(format!("controller-steam-{}", std::process::id()));
        let dmi = root.join("sys/class/dmi/id");
        std::fs::create_dir_all(&dmi).unwrap();
        std::fs::create_dir_all(root.join("etc")).unwrap();
        assert_eq!(steam_in(&root), (false, false));
        std::fs::write(dmi.join("product_name"), "Galileo\n").unwrap();
        assert_eq!(steam_in(&root), (false, false), "a Galileo not made by Valve isn't a Deck");
        std::fs::write(dmi.join("board_vendor"), "Valve\n").unwrap();
        std::fs::write(root.join("etc/os-release"), "NAME=\"SteamOS\"\nID=steamos\n").unwrap();
        assert_eq!(steam_in(&root), (true, true));
        std::fs::remove_dir_all(&root).unwrap();
    }
}

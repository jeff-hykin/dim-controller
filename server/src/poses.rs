//! Saved arm poses, per robot model: `<the app's data dir>/manip_data/<URDF name>/poses.yaml`, a `poses:` list of
//! `{name, color, target}` (target as api/manipulation/target takes it). The page shows each as a button that sets it as
//! the target; the whole list is written at once.
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

/// A URDF name usable as a directory: letters, digits, `.`, `_` and `-` only (no path tricks).
pub fn valid_robot(robot: &str) -> bool {
    !robot.is_empty() && robot.len() <= 100 && !robot.starts_with('.') && robot.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// The robot's poses file in `data` (the app's own folder, dimos_app's `data_dir`), with an older one carried over the
/// first time it's asked for, so nobody's saved poses are left behind by the move.
pub fn file(data: &Path, robot: &str) -> PathBuf {
    let path = data.join("manip_data").join(robot).join("poses.yaml");
    if let Some(old) = carried_over(data, robot).filter(|_| !path.exists()) {
        let _ = std::fs::create_dir_all(path.parent().unwrap());
        if std::fs::copy(&old, &path).is_ok() {
            eprintln!("controller: arm poses carried over from {}", old.display());
        }
    }
    path
}

/// Poses saved before the app kept its own things in its own folder: they went to `app_data/manip_data` under the dimos
/// home, which is a few levels above the folder the app is given, so that's where an older file is looked for (and only
/// there: where the dimos home is, and what else is in it, is Desktop's business).
fn carried_over(data: &Path, robot: &str) -> Option<PathBuf> {
    data.ancestors().skip(1).take(4).map(|dir| dir.join("app_data").join("manip_data").join(robot).join("poses.yaml")).find(|old| old.is_file())
}

/// The saved poses (none when there's no file yet).
pub fn load(data: &Path, robot: &str) -> Result<Vec<Value>> {
    let path = file(data, robot);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(anyhow!("{}: {error}", path.display())),
    };
    let document: Value = serde_yaml::from_str(&text).map_err(|error| anyhow!("{}: {error}", path.display()))?;
    Ok(document["poses"].as_array().cloned().unwrap_or_default())
}

/// Each pose has a name and a target object; color is a string or absent.
pub fn validate(poses: &Value) -> Result<Vec<Value>> {
    let list = poses.as_array().ok_or_else(|| anyhow!("poses: a list"))?;
    for pose in list {
        if !pose["name"].is_string() || !pose["target"].is_object() || !(pose["color"].is_null() || pose["color"].is_string()) {
            return Err(anyhow!("each pose is {{name, color?, target}}"));
        }
    }
    Ok(list.clone())
}

pub fn save(data: &Path, robot: &str, poses: &[Value]) -> Result<PathBuf> {
    let path = file(data, robot);
    std::fs::create_dir_all(path.parent().unwrap())?;
    let text = serde_yaml::to_string(&json!({ "poses": poses }))?;
    std::fs::write(&path, format!("# saved arm poses for {robot} (dim-controller's Arm panel)\n{text}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poses_survive_a_save_and_load_and_names_cannot_escape() {
        let data = std::env::temp_dir().join(format!("poses-test-{}", std::process::id()));
        assert!(load(&data, "r1pro").unwrap().is_empty());
        let poses = validate(&json!([{ "name": "reach", "color": "#e5484d", "target": { "groups": ["left_arm"], "joints": { "r1pro/left_arm_joint1": -0.35 }, "poses": {}, "source": "joints" } }])).unwrap();
        let path = save(&data, "r1pro", &poses).unwrap();
        assert!(path.ends_with("manip_data/r1pro/poses.yaml"));
        assert_eq!(load(&data, "r1pro").unwrap(), poses);
        assert!(validate(&json!([{ "name": "no target" }])).is_err());
        for bad in ["", "..", "../etc", "a/b", ".hidden"] {
            assert!(!valid_robot(bad), "{bad}");
        }
        assert!(valid_robot("r1pro") && valid_robot("xarm7_description-v2.1"));
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn poses_from_where_the_app_used_to_write_them_are_carried_over() {
        let home = std::env::temp_dir().join(format!("poses-old-{}", std::process::id()));
        let data = home.join("data").join("apps").join("dim-controller");
        let old = home.join("app_data").join("manip_data").join("r1pro").join("poses.yaml");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        let poses = validate(&json!([{ "name": "reach", "color": "#e5484d", "target": { "groups": ["left_arm"], "joints": {}, "poses": {}, "source": "joints" } }])).unwrap();
        std::fs::write(&old, serde_yaml::to_string(&json!({ "poses": poses })).unwrap()).unwrap();
        assert_eq!(load(&data, "r1pro").unwrap(), poses);
        assert!(file(&data, "r1pro").is_file() && old.is_file());
        // the copy happens once: what the app saves from here on is its own file
        std::fs::remove_file(&old).unwrap();
        assert_eq!(load(&data, "r1pro").unwrap(), poses);
        let _ = std::fs::remove_dir_all(home);
    }
}

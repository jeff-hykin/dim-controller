//! The page's settings, held here (not in the browser) so the agent can read and change them and every open page
//! follows: a JSON object per key (`lv.view`, `lv.rendering.v2`, `lv.layers.enabled`, `lv.layer.<type>.<topic key>`,
//! `lv.drive.<profile>`, `lv.record.topics`, `lv.record.options`, `lv.cameras`). Saved to `settings.json` in the
//! app's data dir; a change is a `{type: "settings", key, value}` event on the page event stream.
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};

pub struct Settings {
    values: Mutex<Map<String, Value>>,
    file: Option<PathBuf>,
}

pub fn valid_key(key: &str) -> bool {
    key.starts_with("lv.") && key.len() <= 200 && !key.contains(['?', '#'])
}

impl Settings {
    pub fn load(file: Option<PathBuf>) -> Settings {
        let values = file
            .as_ref()
            .and_then(|file| std::fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice::<Map<String, Value>>(&bytes).ok())
            .unwrap_or_default();
        Settings { values: Mutex::new(values), file }
    }

    pub fn all(&self) -> Map<String, Value> {
        self.values.lock().unwrap().clone()
    }

    /// The key's value, or null.
    pub fn get(&self, key: &str) -> Value {
        self.values.lock().unwrap().get(key).cloned().unwrap_or(Value::Null)
    }

    /// Merges `patch`'s fields into the key's object (`null` fields are removed); returns the new value.
    pub fn merge(&self, key: &str, patch: &Map<String, Value>) -> Value {
        let mut values = self.values.lock().unwrap();
        let entry = values.entry(key.to_string()).or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        let object = entry.as_object_mut().unwrap();
        for (field, value) in patch {
            if value.is_null() {
                object.remove(field);
            } else {
                object.insert(field.clone(), value.clone());
            }
        }
        let value = entry.clone();
        if let Some(file) = &self.file {
            if let Some(parent) = file.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(file, serde_json::to_vec_pretty(&*values).unwrap_or_default());
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merges_and_survives_a_restart() {
        let file = std::env::temp_dir().join(format!("lv_settings_{}.json", std::process::id()));
        let _ = std::fs::remove_file(&file);
        let settings = Settings::load(Some(file.clone()));
        settings.merge("lv.view", json!({ "follow": false, "showStats": true }).as_object().unwrap());
        let value = settings.merge("lv.view", json!({ "showStats": null, "fixedFrame": "map" }).as_object().unwrap());
        assert_eq!(value, json!({ "follow": false, "fixedFrame": "map" }));
        assert_eq!(Settings::load(Some(file.clone())).get("lv.view"), value);
        assert!(valid_key("lv.layer.pointcloud.dimos/lidar/sensor_msgs.PointCloud2"));
        assert!(!valid_key("other"));
        let _ = std::fs::remove_file(&file);
    }
}

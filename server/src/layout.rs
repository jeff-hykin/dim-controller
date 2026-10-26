//! The page's layout for the agent: which panels are open where (the arrangement each kind of page keeps,
//! `lv.layout.desktop` / `lv.layout.phone`, which the page writes on every change), the camera panels (`lv.cameras`) and
//! the plots (`lv.plots`). GET reads it whole; PUT sets any part of it; POST api/layout/panel opens, moves or closes one
//! panel (a new camera or plot included). Every change is a settings event, and every open page of that kind applies it
//! (ui/Workspace.tsx useLayoutSync), making it safe as it does any saved arrangement.
use axum::extract::State as Extract;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Map, Value};

use crate::api::{Api, Body};

/// the panels that always exist (ui/workspace.ts FIXED_PANELS); cameras (`camera:<n>`) and plots (`plot:<n>`) come and go
pub const FIXED_PANELS: [&str; 4] = ["map", "scene", "settings", "tf"];
/** a plot's series colors, in order (core/plot.ts SERIES_COLORS) */
const SERIES_COLORS: [&str; 8] = ["#4e9cff", "#ff8a3d", "#3ecf8e", "#e45ce0", "#f2c94c", "#56d4e8", "#ff5c6c", "#a78bfa"];

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn device_key(device: &str) -> Option<&'static str> {
    match device {
        "desktop" => Some("lv.layout.desktop"),
        "phone" => Some("lv.layout.phone"),
        _ => None,
    }
}

/// The arrangement nobody has saved yet: nothing open (a first visit's empty main view).
fn empty_arrangement() -> Value {
    json!({ "stage": null, "left": [], "right": [], "floating": [], "collapsed": [], "closed": FIXED_PANELS, "leftWidth": 320, "rightWidth": 340, "weights": {}, "floatMemory": {} })
}

fn strings(value: &Value) -> Vec<Value> {
    value.as_array().map(|list| list.iter().filter(|item| item.is_string()).cloned().collect()).unwrap_or_default()
}

/// `id` out of every place in `arrangement` (its stage, rails, floating boxes, collapsed and closed lists).
fn without(arrangement: &mut Map<String, Value>, id: &str) {
    if arrangement.get("stage").and_then(Value::as_str) == Some(id) {
        arrangement.insert("stage".into(), Value::Null);
    }
    for list in ["left", "right", "collapsed", "closed"] {
        let kept: Vec<Value> = strings(arrangement.get(list).unwrap_or(&Value::Null)).into_iter().filter(|item| item.as_str() != Some(id)).collect();
        arrangement.insert(list.into(), Value::Array(kept));
    }
    let floating: Vec<Value> = arrangement.get("floating").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(|box_| box_["id"].as_str() != Some(id)).collect();
    arrangement.insert("floating".into(), Value::Array(floating));
}

/// `id` placed at `to` (main, left, right, float or closed) in `arrangement` (null: the empty one). Onto the main view
/// the panel there moves to the top of the left side; a closed camera or plot just leaves (its list drops it).
pub fn place(arrangement: &Value, id: &str, to: &str, index: Option<usize>, float_box: Option<&Value>) -> Result<Value, String> {
    let mut next = match arrangement {
        Value::Object(object) => object.clone(),
        _ => empty_arrangement().as_object().unwrap().clone(),
    };
    let previous_stage = next.get("stage").and_then(Value::as_str).map(str::to_string);
    without(&mut next, id);
    match to {
        "main" => {
            if let Some(previous) = previous_stage.filter(|previous| previous != id) {
                let mut left = strings(&next["left"]);
                left.insert(0, json!(previous));
                next.insert("left".into(), Value::Array(left));
                next.insert("previousStage".into(), json!(previous));
            }
            next.insert("stage".into(), json!(id));
        }
        "left" | "right" => {
            let mut rail = strings(&next[to]);
            let at = index.unwrap_or(rail.len()).min(rail.len());
            rail.insert(at, json!(id));
            next.insert(to.into(), Value::Array(rail));
        }
        "float" => {
            let mut box_ = json!({ "x": 240, "y": 120, "width": 460, "height": 320 });
            if let Some(Value::Object(given)) = float_box {
                for field in ["x", "y", "width", "height"] {
                    if let Some(number) = given.get(field).filter(|value| value.is_number()) {
                        box_[field] = number.clone();
                    }
                }
            }
            box_["id"] = json!(id);
            let mut floating = next["floating"].as_array().cloned().unwrap_or_default();
            floating.push(box_);
            next.insert("floating".into(), Value::Array(floating));
        }
        "closed" => {
            if !(id.starts_with("camera:") || id.starts_with("plot:")) {
                let mut closed = strings(&next["closed"]);
                closed.push(json!(id));
                next.insert("closed".into(), Value::Array(closed));
            }
        }
        _ => return Err(format!("to: one of main, left, right, float, closed (not {to:?})")),
    }
    Ok(Value::Object(next))
}

/// Sets a setting's fields and tells every page (as PATCH api/settings does).
fn set(api: &Api, key: &str, patch: Value) -> Value {
    let value = api.settings.merge(key, patch.as_object().unwrap());
    api.annotations.broadcast(json!({ "type": "settings", "key": key, "value": value, "from": "agent" }));
    value
}

fn layout_of(api: &Api) -> Value {
    let cameras = api.settings.get("lv.cameras")["panels"].clone();
    let plots = api.settings.get("lv.plots")["plots"].clone();
    json!({
        "desktop": api.settings.get("lv.layout.desktop")["arrangement"].clone(),
        "phone": api.settings.get("lv.layout.phone")["arrangement"].clone(),
        "cameras": if cameras.is_array() { cameras } else { json!([]) },
        "plots": if plots.is_array() { plots } else { json!([]) },
        "fixedPanels": FIXED_PANELS,
    })
}

pub async fn get(Extract(api): Extract<Api>) -> Response {
    Json(layout_of(&api)).into_response()
}

pub async fn put(Extract(api): Extract<Api>, Body(body): Body) -> Response {
    for (field, key) in [("desktop", "lv.layout.desktop"), ("phone", "lv.layout.phone")] {
        match &body[field] {
            Value::Null => {}
            Value::Object(_) => {
                set(&api, key, json!({ "arrangement": body[field] }));
            }
            _ => return error(StatusCode::BAD_REQUEST, &format!("{field}: an arrangement object (GET api/layout shows one)")),
        }
    }
    for (field, key, inner) in [("cameras", "lv.cameras", "panels"), ("plots", "lv.plots", "plots")] {
        match &body[field] {
            Value::Null => {}
            Value::Array(list) => {
                set(&api, key, json!({ inner: list }));
            }
            _ => return error(StatusCode::BAD_REQUEST, &format!("{field}: a list (GET api/layout shows one)")),
        }
    }
    Json(layout_of(&api)).into_response()
}

/// The next free id in a list of objects with integer `id`s.
fn next_id(list: &[Value]) -> u64 {
    list.iter().filter_map(|item| item["id"].as_u64()).max().unwrap_or(0) + 1
}

pub async fn panel(Extract(api): Extract<Api>, Body(body): Body) -> Response {
    let Some(requested) = body["panel"].as_str() else {
        return error(StatusCode::BAD_REQUEST, "panel: a panel id (map, scene, settings, tf, camera:<n>, plot:<n>), or camera / plot for a new one");
    };
    let to = body["to"].as_str().unwrap_or("main");
    let device = body["device"].as_str().unwrap_or("desktop");
    let Some(key) = device_key(device) else {
        return error(StatusCode::BAD_REQUEST, "device: desktop or phone");
    };
    let mut cameras = api.settings.get("lv.cameras")["panels"].as_array().cloned().unwrap_or_default();
    let mut plots = api.settings.get("lv.plots")["plots"].as_array().cloned().unwrap_or_default();
    let id = match requested {
        "camera" => {
            if to == "closed" {
                return error(StatusCode::BAD_REQUEST, "a new camera can't be opened closed");
            }
            let id = next_id(&cameras);
            cameras.push(json!({ "id": id, "key": body["topic"].as_str().unwrap_or(""), "overlay": "" }));
            set(&api, "lv.cameras", json!({ "panels": cameras }));
            format!("camera:{id}")
        }
        "plot" => {
            if to == "closed" {
                return error(StatusCode::BAD_REQUEST, "a new plot can't be opened closed");
            }
            let id = next_id(&plots);
            let series: Vec<Value> = body["series"].as_array().cloned().unwrap_or_default().iter().enumerate().filter_map(|(index, one)| {
                Some(json!({ "id": format!("s{index}"), "key": one["key"].as_str()?, "field": one["field"].as_str().unwrap_or("data"), "color": SERIES_COLORS[index % SERIES_COLORS.len()] }))
            }).collect();
            plots.push(json!({ "id": id, "series": series }));
            set(&api, "lv.plots", json!({ "plots": plots }));
            format!("plot:{id}")
        }
        other => {
            let known = FIXED_PANELS.contains(&other)
                || other.strip_prefix("camera:").and_then(|n| n.parse::<u64>().ok()).is_some_and(|n| cameras.iter().any(|c| c["id"].as_u64() == Some(n)))
                || other.strip_prefix("plot:").and_then(|n| n.parse::<u64>().ok()).is_some_and(|n| plots.iter().any(|p| p["id"].as_u64() == Some(n)));
            if !known {
                return error(StatusCode::NOT_FOUND, &format!("no panel {other:?} (GET api/layout lists them)"));
            }
            other.to_string()
        }
    };
    let arrangement = api.settings.get(key)["arrangement"].clone();
    let next = match place(&arrangement, &id, to, body["index"].as_u64().map(|n| n as usize), body.get("box")) {
        Ok(next) => next,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };
    set(&api, key, json!({ "arrangement": next }));
    // a camera or plot closed leaves its list too
    if to == "closed" {
        if let Some(n) = id.strip_prefix("camera:").and_then(|n| n.parse::<u64>().ok()) {
            cameras.retain(|c| c["id"].as_u64() != Some(n));
            set(&api, "lv.cameras", json!({ "panels": cameras }));
        }
        if let Some(n) = id.strip_prefix("plot:").and_then(|n| n.parse::<u64>().ok()) {
            plots.retain(|p| p["id"].as_u64() != Some(n));
            set(&api, "lv.plots", json!({ "plots": plots }));
        }
    }
    Json(json!({ "panel": id, "layout": layout_of(&api) })).into_response()
}

#[cfg(test)]
mod tests {
    use super::place;
    use serde_json::json;

    #[test]
    fn placing_panels() {
        // from nothing saved: everything closed, the 3D view onto the main view
        let first = place(&json!(null), "scene", "main", None, None).unwrap();
        assert_eq!(first["stage"], "scene");
        assert_eq!(first["closed"], json!(["map", "settings", "tf"]));
        // the map onto the main view: the 3D view moves to the top of the left side
        let swapped = place(&first, "map", "main", None, None).unwrap();
        assert_eq!([&swapped["stage"], &swapped["left"]], [&json!("map"), &json!(["scene"])]);
        // into a side at an index, then floating with a box, then closed
        let right = place(&swapped, "settings", "right", Some(0), None).unwrap();
        assert_eq!(right["right"], json!(["settings"]));
        let floated = place(&right, "settings", "float", None, Some(&json!({ "x": 10, "y": 20, "width": 300, "height": 200 }))).unwrap();
        assert_eq!(floated["right"], json!([]));
        assert_eq!(floated["floating"], json!([{ "id": "settings", "x": 10, "y": 20, "width": 300, "height": 200 }]));
        let closed = place(&floated, "settings", "closed", None, None).unwrap();
        assert_eq!(closed["floating"], json!([]));
        assert!(closed["closed"].as_array().unwrap().contains(&json!("settings")));
        // a camera closed isn't listed closed (its list drops it)
        let camera = place(&closed, "camera:1", "closed", None, None).unwrap();
        assert!(!camera["closed"].as_array().unwrap().contains(&json!("camera:1")));
        assert!(place(&closed, "map", "sideways", None, None).is_err());
    }
}

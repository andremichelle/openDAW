use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Manager, Wry};

use crate::{request_quit, APP};

const QUIT_ID: &str = "__quit__";
const ZOOM_IN_ID: &str = "__zoom_in__";
const ZOOM_OUT_ID: &str = "__zoom_out__";
const ZOOM_RESET_ID: &str = "__zoom_reset__";

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Node {
    Item { id: String, label: String, enabled: bool, accelerator: Option<String> },
    Check { id: String, label: String, enabled: bool, checked: bool, accelerator: Option<String> },
    Submenu { label: String, enabled: bool, items: Vec<Node> },
    Separator,
    Native { role: String },
}

#[derive(Deserialize)]
struct Top {
    label: String,
    role: Option<String>,
    items: Vec<Node>,
}

// what changes in place, in the order the bar lists it (a submenu before its items)
enum Slot {
    Item(MenuItem<Wry>),
    Check(CheckMenuItem<Wry>),
    Submenu(Submenu<Wry>),
}

// the menu on screen: its structure, its slots, and per item the page's latest id (the page numbers anew every time)
struct Built {
    structure: serde_json::Value,
    slots: Vec<Slot>,
    routes: HashMap<String, String>,
}

static BUILT: Mutex<Option<Built>> = Mutex::new(None);

// the states of the slots, in their order: the page's id, enabled, checked
fn states(nodes: &[Node], out: &mut Vec<(String, bool, bool)>) {
    for node in nodes {
        match node {
            Node::Item { id, enabled, .. } => out.push((id.clone(), *enabled, false)),
            Node::Check { id, enabled, checked, .. } => out.push((id.clone(), *enabled, *checked)),
            Node::Submenu { enabled, items, .. } => {
                out.push((String::new(), *enabled, false));
                states(items, out);
            }
            _ => {}
        }
    }
}

fn append(app: &AppHandle, parent: &Submenu<Wry>, node: &Node, slots: &mut Vec<Slot>) -> tauri::Result<()> {
    match node {
        Node::Item { id, label, enabled, accelerator } => {
            let item = MenuItem::with_id(app, id, label, *enabled, accelerator.as_deref())?;
            slots.push(Slot::Item(item.clone()));
            parent.append(&item)
        }
        Node::Check { id, label, enabled, checked, accelerator } => {
            let item = CheckMenuItem::with_id(app, id, label, *enabled, *checked, accelerator.as_deref())?;
            slots.push(Slot::Check(item.clone()));
            parent.append(&item)
        }
        Node::Submenu { label, enabled, items } => {
            let submenu = Submenu::new(app, label, *enabled)?;
            slots.push(Slot::Submenu(submenu.clone()));
            for item in items {
                append(app, &submenu, item, slots)?;
            }
            parent.append(&submenu)
        }
        Node::Separator => parent.append(&PredefinedMenuItem::separator(app)?),
        Node::Native { role } if role == "quit" =>
            parent.append(&MenuItem::with_id(app, QUIT_ID, "Quit openDAW Studio", true, Some("CmdOrCtrl+Q"))?),
        Node::Native { role } if role == "zoom-in" =>
            parent.append(&MenuItem::with_id(app, ZOOM_IN_ID, "Zoom In", true, Some("CmdOrCtrl+="))?),
        Node::Native { role } if role == "zoom-out" =>
            parent.append(&MenuItem::with_id(app, ZOOM_OUT_ID, "Zoom Out", true, Some("CmdOrCtrl+-"))?),
        Node::Native { role } if role == "zoom-reset" =>
            parent.append(&MenuItem::with_id(app, ZOOM_RESET_ID, "Actual Size", true, Some("CmdOrCtrl+0"))?),
        Node::Native { role } => {
            let item = match role.as_str() {
                "about" => PredefinedMenuItem::about(app, None, None)?,
                "services" => PredefinedMenuItem::services(app, None)?,
                "hide" => PredefinedMenuItem::hide(app, None)?,
                "hide-others" => PredefinedMenuItem::hide_others(app, None)?,
                "show-all" => PredefinedMenuItem::show_all(app, None)?,
                "cut" => PredefinedMenuItem::cut(app, None)?,
                "copy" => PredefinedMenuItem::copy(app, None)?,
                "paste" => PredefinedMenuItem::paste(app, None)?,
                "select-all" => PredefinedMenuItem::select_all(app, None)?,
                "minimize" => PredefinedMenuItem::minimize(app, None)?,
                "zoom" => PredefinedMenuItem::maximize(app, None)?,
                "fullscreen" => PredefinedMenuItem::fullscreen(app, None)?,
                "close-window" => PredefinedMenuItem::close_window(app, None)?,
                _ => return Ok(()),
            };
            parent.append(&item)
        }
    }
}

// the bar without what changes in place (ids, enabled, checked): equal means the existing menu is updated, not replaced
fn structure(bar: &serde_json::Value) -> serde_json::Value {
    match bar {
        serde_json::Value::Array(items) => serde_json::Value::Array(items.iter().map(structure).collect()),
        serde_json::Value::Object(map) => serde_json::Value::Object(map.iter()
            .filter(|(key, _)| !matches!(key.as_str(), "id" | "enabled" | "checked"))
            .map(|(key, value)| (key.clone(), structure(value))).collect()),
        other => other.clone(),
    }
}

// Replaces the app menu with the bar the page describes; clicks on its items are sent back by id
pub fn set(json: &[u8]) -> Result<(), String> {
    let bar: Vec<Top> = serde_json::from_slice(json).map_err(|error| error.to_string())?;
    let shape = structure(&serde_json::from_slice(json).map_err(|error| error.to_string())?);
    let app = APP.get().ok_or("app not ready")?;
    let mut built = BUILT.lock().unwrap();
    if let Some(current) = built.as_mut().filter(|current| current.structure == shape) {
        let mut wanted = Vec::new();
        bar.iter().for_each(|top| states(&top.items, &mut wanted));
        for (slot, (id, enabled, checked)) in current.slots.iter().zip(wanted) {
            match slot {
                Slot::Item(item) => {
                    let _ = item.set_enabled(enabled);
                    current.routes.insert(item.id().0.clone(), id);
                }
                Slot::Check(item) => {
                    let _ = item.set_enabled(enabled);
                    let _ = item.set_checked(checked);
                    current.routes.insert(item.id().0.clone(), id);
                }
                Slot::Submenu(submenu) => {let _ = submenu.set_enabled(enabled);}
            }
        }
        return Ok(());
    }
    let mut slots = Vec::new();
    let mut build = || -> tauri::Result<Menu<Wry>> {
        let menu = Menu::new(app)?;
        for (index, top) in bar.iter().enumerate() {
            let id = match top.role.as_deref() {
                Some("window") => WINDOW_SUBMENU_ID.to_string(),
                Some("help") => HELP_SUBMENU_ID.to_string(),
                _ => format!("menu-{index}"),
            };
            let submenu = Submenu::with_id(app, id, &top.label, true)?;
            for node in &top.items {
                append(app, &submenu, node, &mut slots)?;
            }
            menu.append(&submenu)?;
        }
        Ok(menu)
    };
    let menu = build().map_err(|error| error.to_string())?;
    app.set_menu(menu).map_err(|error| error.to_string())?;
    *built = Some(Built { structure: shape, slots, routes: HashMap::new() });
    Ok(())
}

pub fn clicked(app: &AppHandle, id: &str) {
    if id == QUIT_ID {
        return request_quit(app);
    }
    let zoom = match id {
        ZOOM_IN_ID => Some(crate::zoom::Step::In),
        ZOOM_OUT_ID => Some(crate::zoom::Step::Out),
        ZOOM_RESET_ID => Some(crate::zoom::Step::Reset),
        _ => None,
    };
    if let Some(step) = zoom {
        return crate::zoom::step(app, step);
    }
    let id = BUILT.lock().unwrap().as_ref().and_then(|built| built.routes.get(id).cloned()).unwrap_or_else(|| id.to_string());
    if let Some(window) = app.get_webview_window("main") {
        let id = serde_json::to_string(&id).unwrap();
        let _ = window.eval(format!("window.__OPENDAW_SHELL__?.menu?.({id})"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bar(id: &str, enabled: bool, checked: bool, label: &str) -> serde_json::Value {
        json!([{"label": "View", "items": [
            {"type": "check", "id": id, "label": label, "enabled": enabled, "checked": checked},
            {"type": "submenu", "label": "More", "enabled": enabled, "items": [{"type": "item", "id": format!("{id}-sub"), "label": "Sub", "enabled": true}]},
            {"type": "separator"}, {"type": "native", "role": "fullscreen"}
        ]}])
    }

    // Windows draws the menu bar inside the window: replacing it lets the studio jump for a frame, a project change or a
    // checkmark only updates the items
    #[test]
    fn only_a_changed_structure_replaces_the_menu() {
        assert_eq!(structure(&bar("1", true, false, "Keyboard")), structure(&bar("17", false, true, "Keyboard")));
        assert_ne!(structure(&bar("1", true, false, "Keyboard")), structure(&bar("1", true, false, "Piano")));
        assert_ne!(structure(&bar("1", true, false, "Keyboard")), structure(&json!([{"label": "View", "items": []}])));
    }
}

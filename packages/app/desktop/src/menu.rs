use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Manager, Wry};

use crate::{request_quit, APP};

const QUIT_ID: &str = "__quit__";

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

fn append(app: &AppHandle, parent: &Submenu<Wry>, node: &Node) -> tauri::Result<()> {
    match node {
        Node::Item { id, label, enabled, accelerator } =>
            parent.append(&MenuItem::with_id(app, id, label, *enabled, accelerator.as_deref())?),
        Node::Check { id, label, enabled, checked, accelerator } =>
            parent.append(&CheckMenuItem::with_id(app, id, label, *enabled, *checked, accelerator.as_deref())?),
        Node::Submenu { label, enabled, items } => {
            let submenu = Submenu::new(app, label, *enabled)?;
            for item in items {
                append(app, &submenu, item)?;
            }
            parent.append(&submenu)
        }
        Node::Separator => parent.append(&PredefinedMenuItem::separator(app)?),
        Node::Native { role } if role == "quit" =>
            parent.append(&MenuItem::with_id(app, QUIT_ID, "Quit openDAW Studio", true, Some("CmdOrCtrl+Q"))?),
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

// Replaces the app menu with the bar the page describes; clicks on its items are sent back by id
pub fn set(json: &[u8]) -> Result<(), String> {
    let bar: Vec<Top> = serde_json::from_slice(json).map_err(|error| error.to_string())?;
    let app = APP.get().ok_or("app not ready")?;
    let build = || -> tauri::Result<Menu<Wry>> {
        let menu = Menu::new(app)?;
        for (index, top) in bar.iter().enumerate() {
            let id = match top.role.as_deref() {
                Some("window") => WINDOW_SUBMENU_ID.to_string(),
                Some("help") => HELP_SUBMENU_ID.to_string(),
                _ => format!("menu-{index}"),
            };
            let submenu = Submenu::with_id(app, id, &top.label, true)?;
            for node in &top.items {
                append(app, &submenu, node)?;
            }
            menu.append(&submenu)?;
        }
        Ok(menu)
    };
    let menu = build().map_err(|error| error.to_string())?;
    app.set_menu(menu).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn clicked(app: &AppHandle, id: &str) {
    if id == QUIT_ID {
        return request_quit(app);
    }
    if let Some(window) = app.get_webview_window("main") {
        let id = serde_json::to_string(id).unwrap();
        let _ = window.eval(format!("window.__OPENDAW_SHELL__?.menu?.({id})"));
    }
}

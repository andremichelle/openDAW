// View > Zoom In, Zoom Out, Actual Size: the webview's own zoom keys are off in Tauri, the shell zooms the main window
// in browser-like steps and keeps the level for the next start
use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Clone, Copy)]
pub enum Step {
    In,
    Out,
    Reset,
}

const LEVELS: [f64; 13] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

static LEVEL: Mutex<f64> = Mutex::new(1.0);

pub fn next(current: f64, step: Step) -> f64 {
    match step {
        Step::Reset => 1.0,
        Step::In => LEVELS.iter().copied().find(|level| *level > current + 1e-6).unwrap_or(LEVELS[LEVELS.len() - 1]),
        Step::Out => LEVELS.iter().rev().copied().find(|level| *level < current - 1e-6).unwrap_or(LEVELS[0]),
    }
}

fn file(app: &AppHandle) -> Option<std::path::PathBuf> {app.path().app_data_dir().ok().map(|dir| dir.join("zoom"))}

// the level of the last session
pub fn restore(window: &WebviewWindow) {
    let saved = file(window.app_handle()).and_then(|file| std::fs::read_to_string(file).ok()).and_then(|text| text.trim().parse::<f64>().ok());
    let Some(level) = saved.map(|level| level.clamp(LEVELS[0], LEVELS[LEVELS.len() - 1])) else { return };
    *LEVEL.lock().unwrap() = level;
    let _ = window.set_zoom(level);
}

pub fn step(app: &AppHandle, step: Step) {
    let level = {
        let mut current = LEVEL.lock().unwrap();
        *current = next(*current, step);
        *current
    };
    if let Some(window) = app.get_webview_window("main") { let _ = window.set_zoom(level); }
    if let Some(file) = file(app) { let _ = std::fs::write(file, level.to_string()); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_moves_in_browser_steps_and_stops_at_the_ends() {
        assert_eq!(next(1.0, Step::In), 1.1);
        assert_eq!(next(1.0, Step::Out), 0.9);
        assert_eq!(next(1.75, Step::Reset), 1.0);
        assert_eq!(next(3.0, Step::In), 3.0);
        assert_eq!(next(0.5, Step::Out), 0.5);
        // a level from elsewhere snaps to the next step in its direction
        assert_eq!(next(1.2, Step::In), 1.25);
        assert_eq!(next(1.2, Step::Out), 1.1);
        assert_eq!(LEVELS.iter().filter(|level| **level == 1.0).count(), 1);
    }
}

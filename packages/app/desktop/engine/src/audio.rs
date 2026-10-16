// Output device and buffer size for the page, independent of any open project
use std::net::TcpStream;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tungstenite::{Message, WebSocket};

use crate::{request_main, MainRequest, OUTPUT_CURRENT, OUTPUT_DEVICES, OUTPUT_NAME};

#[derive(Serialize, PartialEq, Clone)]
struct State {
    #[serde(rename = "type")]
    kind: &'static str,
    devices: Vec<String>,
    device: String,
    buffer: u32,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ToEngine {
    // device "" is the system default
    Output { device: String, buffer: u32 },
}

fn state() -> State {
    let devices = OUTPUT_DEVICES.lock().unwrap().split('\n').filter(|name| !name.is_empty()).map(String::from).collect();
    State { kind: "output", devices, device: OUTPUT_NAME.lock().unwrap().clone(), buffer: OUTPUT_CURRENT.lock().unwrap().1 }
}

pub fn serve(mut socket: WebSocket<TcpStream>) {
    let _ = socket.get_ref().set_read_timeout(Some(Duration::from_millis(50)));
    let mut sent: Option<State> = None;
    let mut next = Instant::now();
    loop {
        if Instant::now() >= next {
            next = Instant::now() + Duration::from_millis(500);
            let current = state();
            if sent.as_ref() != Some(&current) {
                if socket.send(Message::Text(serde_json::to_string(&current).unwrap().into())).is_err() { break; }
                sent = Some(current);
            }
        }
        match socket.read() {
            Ok(Message::Text(text)) => match serde_json::from_str::<ToEngine>(&text) {
                Ok(ToEngine::Output { device, buffer }) => {
                    request_main(MainRequest::Output(device, buffer));
                    next = Instant::now() + Duration::from_millis(100);
                }
                Err(error) => eprintln!("[audio] {error}"),
            },
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(error)) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(_) => break,
        }
    }
}

// Output device and buffer size for the page, independent of any open project
use std::net::TcpStream;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tungstenite::{Message, WebSocket};

use crate::{request_main, MainRequest, OUTPUT_CURRENT, OUTPUT_DEVICES, OUTPUT_NAME, SAMPLE_RATE};

#[derive(Serialize, PartialEq, Clone)]
struct State {
    #[serde(rename = "type")]
    kind: &'static str,
    devices: Vec<String>,
    device: String,
    buffer: u32,
    // the rate the card actually runs at, the studio's engines must run at it
    #[serde(rename = "sampleRate")]
    sample_rate: u32,
    // Windows only: the card taken exclusively, the studio offers the choice where this is present
    #[serde(skip_serializing_if = "Option::is_none")]
    exclusive: Option<bool>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ToEngine {
    // device "" is the system default
    Output { device: String, buffer: u32, #[serde(default)] exclusive: bool },
}

fn state() -> State {
    let devices = OUTPUT_DEVICES.lock().unwrap().split('\n').filter(|name| !name.is_empty()).map(String::from).collect();
    State {
        kind: "output", devices, device: OUTPUT_NAME.lock().unwrap().clone(), buffer: OUTPUT_CURRENT.lock().unwrap().1,
        sample_rate: SAMPLE_RATE.load(std::sync::atomic::Ordering::Relaxed),
        exclusive: cfg!(target_os = "windows").then(|| OUTPUT_CURRENT.lock().unwrap().2)
    }
}

pub fn serve(mut socket: WebSocket<TcpStream>) {
    crate::poll::poll(&socket);
    let mut sent: Option<State> = None;
    let mut next = Instant::now();
    loop {
        if Instant::now() >= next {
            next = Instant::now() + Duration::from_millis(500);
            let current = state();
            if sent.as_ref() != Some(&current) {
                if crate::poll::send(&mut socket, Message::Text(serde_json::to_string(&current).unwrap().into())).is_err() { break; }
                sent = Some(current);
            }
        }
        match crate::poll::read(&mut socket, Duration::from_millis(50)) {
            Ok(Some(Message::Text(text))) => match serde_json::from_str::<ToEngine>(&text) {
                Ok(ToEngine::Output { device, buffer, exclusive }) => {
                    request_main(MainRequest::Output(device, buffer, exclusive));
                    next = Instant::now() + Duration::from_millis(100);
                }
                Err(error) => eprintln!("[audio] {error}"),
            },
            Ok(Some(Message::Close(_))) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
}

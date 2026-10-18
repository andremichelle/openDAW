// MIDI for the page (WKWebView and WebKitGTK have no Web MIDI): devices through midir, one WebSocket per page
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::net::TcpStream;
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use midir::{MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::{Deserialize, Serialize};
use tungstenite::{Message, WebSocket};

const CLIENT: &str = "openDAW";

#[derive(Serialize, Clone, PartialEq)]
struct Port {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ToStudio<'a> {
    Devices { inputs: &'a [Port], outputs: &'a [Port] },
    Message { id: &'a str, data: &'a [u8] },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ToEngine {
    // delay in milliseconds from now (the page converts its timestamp)
    Send { id: String, data: Vec<u8>, delay: f64 },
}

fn list() -> (Vec<Port>, Vec<Port>) {
    let inputs = MidiInput::new(CLIENT).map(|midi| midi.ports().iter()
        .map(|port| Port { id: port.id(), name: midi.port_name(port).unwrap_or_default() }).collect()).unwrap_or_default();
    let outputs = MidiOutput::new(CLIENT).map(|midi| midi.ports().iter()
        .map(|port| Port { id: port.id(), name: midi.port_name(port).unwrap_or_default() }).collect()).unwrap_or_default();
    (inputs, outputs)
}

fn send_json(socket: &mut WebSocket<TcpStream>, message: &ToStudio) -> bool {
    crate::poll::send(socket, Message::Text(serde_json::to_string(message).unwrap().into())).is_ok()
}

pub fn serve(mut socket: WebSocket<TcpStream>) {
    crate::poll::poll(&socket);
    let (incoming, received) = channel::<(String, Vec<u8>)>();
    let mut connections: HashMap<String, MidiInputConnection<()>> = HashMap::new();
    let mut outputs: HashMap<String, MidiOutputConnection> = HashMap::new();
    let mut scheduled: BinaryHeap<Reverse<(Instant, u64, String, Vec<u8>)>> = BinaryHeap::new();
    let mut order = 0u64;
    // None until the first scan, so the page always gets a first list, even an empty one
    let mut known: Option<(Vec<Port>, Vec<Port>)> = None;
    let mut next_scan = Instant::now();
    println!("[midi] page connected");
    loop {
        if Instant::now() >= next_scan {
            next_scan = Instant::now() + Duration::from_secs(2);
            // CoreMIDI updates its device list only for threads that run their run loop
            #[cfg(target_os = "macos")]
            unsafe {
                core_foundation::runloop::CFRunLoop::run_in_mode(
                    core_foundation::runloop::kCFRunLoopDefaultMode, Duration::from_millis(10), false);
            }
            let current = list();
            if known.as_ref() != Some(&current) {
                let known = known.insert(current);
                println!("[midi] inputs: {}", known.0.iter().map(|port| port.name.as_str()).collect::<Vec<_>>().join(", "));
                connections.retain(|id, _| known.0.iter().any(|port| port.id == *id));
                outputs.retain(|id, _| known.1.iter().any(|port| port.id == *id));
                for port in &known.0 {
                    if connections.contains_key(&port.id) { continue; }
                    let Ok(midi) = MidiInput::new(CLIENT) else { continue };
                    let Some(handle) = midi.find_port_by_id(&port.id) else { continue };
                    let (sender, id) = (incoming.clone(), port.id.clone());
                    match midi.connect(&handle, CLIENT, move |_, data, _| {let _ = sender.send((id.clone(), data.to_vec()));}, ()) {
                        Ok(connection) => {connections.insert(port.id.clone(), connection);}
                        Err(error) => eprintln!("[midi] cannot open input {}: {error}", port.name),
                    }
                }
                if !send_json(&mut socket, &ToStudio::Devices { inputs: &known.0, outputs: &known.1 }) { break; }
            }
        }
        match crate::poll::read(&mut socket, Duration::from_millis(1)) {
            Ok(Some(Message::Text(text))) => match serde_json::from_str::<ToEngine>(&text) {
                Ok(ToEngine::Send { id, data, delay }) => {
                    order += 1;
                    scheduled.push(Reverse((Instant::now() + Duration::from_secs_f64(delay.max(0.0) / 1000.0), order, id, data)));
                }
                Err(error) => eprintln!("[midi] {error}"),
            },
            Ok(Some(Message::Close(_))) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        while scheduled.peek().is_some_and(|Reverse((at, ..))| *at <= Instant::now()) {
            let Some(Reverse((_, _, id, data))) = scheduled.pop() else { break };
            if !outputs.contains_key(&id) {
                let connection = MidiOutput::new(CLIENT).ok()
                    .and_then(|midi| midi.find_port_by_id(&id).and_then(|port| midi.connect(&port, CLIENT).ok()));
                match connection {
                    Some(connection) => {outputs.insert(id.clone(), connection);}
                    None => continue,
                }
            }
            if let Some(output) = outputs.get_mut(&id) {
                let _ = output.send(&data);
            }
        }
        while let Ok((id, data)) = received.try_recv() {
            if !send_json(&mut socket, &ToStudio::Message { id: &id, data: &data }) { break; }
        }
    }
    println!("[midi] page disconnected");
}

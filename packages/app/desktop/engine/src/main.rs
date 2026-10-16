// The native engine process: embedded V8 runs the studio's unchanged wasm-processor bundle, cpal plays it,
// and every studio engine instance talks to it over one loopback WebSocket
use std::collections::HashMap;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::Message;

const QUANTUM: usize = 128;
const PORT: u16 = 47112;
const PRELUDE: &str = r#"
    globalThis.self = globalThis
    globalThis.location = {href: "/"}
    globalThis.console = {log: (...args) => __print(args.join(" ")), debug: () => {}, info: (...args) => __print(args.join(" ")),
        warn: (...args) => __print("warn " + args.join(" ")), error: (...args) => __print("error " + args.join(" "))}
    globalThis.crypto = {getRandomValues: array => {for (let index = 0; index < array.length; index++) {array[index] = Math.random() * 256 | 0} return array}}
    globalThis.performance = {now: () => __now()}
    globalThis.queueMicrotask = callback => Promise.resolve().then(callback)
    {
        const timers = new Map()
        let next = 1
        globalThis.setTimeout = (callback, delay = 0, ...args) => {
            const id = next++
            timers.set(id, {at: __now() + delay, callback, args})
            return id
        }
        globalThis.clearTimeout = id => timers.delete(id)
        globalThis.__timers = () => {
            const now = __now()
            for (const [id, timer] of timers) {
                if (timer.at <= now) {
                    timers.delete(id)
                    timer.callback(...timer.args)
                }
            }
        }
    }
    globalThis.TextDecoder = class {
        decode(bytes) {
            const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer ?? bytes)
            let result = ""
            for (let index = 0; index < array.length; index++) {result += String.fromCharCode(array[index])}
            try {return decodeURIComponent(escape(result))} catch (error) {return result}
        }
    }
    globalThis.fetch = async url => {
        const bytes = __read(String(url))
        return {ok: bytes !== undefined, status: bytes === undefined ? 404 : 200, statusText: "",
            arrayBuffer: async () => bytes, json: async () => JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)))}
    }
"#;

static DIST: OnceLock<PathBuf> = OnceLock::new();
static STARTED: OnceLock<Instant> = OnceLock::new();
static OUTBOX: OnceLock<Mutex<HashMap<i32, Sender<Option<Vec<u8>>>>>> = OnceLock::new();

enum Event {
    Open(i32),
    Receive(i32, Vec<u8>),
    Close(i32),
}

fn outbox() -> &'static Mutex<HashMap<i32, Sender<Option<Vec<u8>>>>> {
    OUTBOX.get_or_init(|| Mutex::new(HashMap::new()))
}

fn print(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let parts: Vec<String> = (0..args.length()).map(|index| args.get(index).to_rust_string_lossy(scope)).collect();
    println!("[js] {}", parts.join(" "));
}

fn now(_scope: &mut v8::PinScope, _args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    rv.set_double(STARTED.get().unwrap().elapsed().as_secs_f64() * 1000.0);
}

fn read(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let url = args.get(0).to_rust_string_lossy(scope);
    let path = url.split(['?', '#']).next().unwrap_or("").trim_start_matches('/');
    match std::fs::read(DIST.get().unwrap().join(path)) {
        Ok(bytes) => {
            let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
            rv.set(v8::ArrayBuffer::with_backing_store(scope, &store).into());
        }
        Err(_) => println!("[engine] missing {url}"),
    }
}

fn send(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let id = args.get(0).int32_value(scope).unwrap_or(-1);
    let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(args.get(1)) else { return };
    let store = buffer.get_backing_store();
    let bytes = match store.data() {
        Some(data) => unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, buffer.byte_length()) }.to_vec(),
        None => Vec::new(),
    };
    if let Some(sender) = outbox().lock().unwrap().get(&id) {
        let _ = sender.send(Some(bytes));
    }
}

fn close(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let id = args.get(0).int32_value(scope).unwrap_or(-1);
    if let Some(sender) = outbox().lock().unwrap().remove(&id) {
        let _ = sender.send(None);
    }
}

fn run<'s>(scope: &mut v8::PinScope<'s, '_>, source: &str, name: &str) -> Option<v8::Local<'s, v8::Value>> {
    v8::tc_scope!(let try_catch, scope);
    let code = v8::String::new(try_catch, source).unwrap();
    let origin_name = v8::String::new(try_catch, name).unwrap();
    let origin = v8::ScriptOrigin::new(try_catch, origin_name.into(), 0, 0, false, 0, None, false, false, false, None);
    let result = v8::Script::compile(try_catch, code, Some(&origin)).and_then(|script| script.run(try_catch));
    if result.is_none() {
        let message = try_catch.exception().map(|exception| exception.to_rust_string_lossy(try_catch)).unwrap_or_default();
        let stack = try_catch.stack_trace().map(|stack| stack.to_rust_string_lossy(try_catch)).unwrap_or_default();
        eprintln!("[engine] {name} threw: {message}\n{stack}");
    }
    result
}

fn bridge_function<'s>(scope: &mut v8::PinScope<'s, '_>, name: &str) -> v8::Local<'s, v8::Function> {
    v8::Local::<v8::Function>::try_from(run(scope, &format!("__bridge.{name}"), name).expect("bridge")).unwrap()
}

fn processor_source(dist: &PathBuf) -> String {
    let entry = std::fs::read_dir(dist).expect("dist").flatten()
        .find(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with("wasm-processor.") && name.ends_with(".js")
        })
        .expect("no wasm-processor bundle in the dist");
    std::fs::read_to_string(entry.path()).unwrap().replace("import.meta.url", "self.location.href")
}

fn engine_thread(events: Receiver<Event>, mut producer: rtrb::Producer<f32>, sample_rate: u32) {
    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform.clone());
    v8::V8::initialize();
    let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
    v8::scope!(let handle_scope, isolate);
    let global = v8::ObjectTemplate::new(handle_scope);
    macro_rules! native {
        ($name:literal, $callback:expr) => {
            global.set(v8::String::new(handle_scope, $name).unwrap().into(), v8::FunctionTemplate::new(handle_scope, $callback).into());
        };
    }
    native!("__print", print);
    native!("__now", now);
    native!("__read", read);
    native!("__send", send);
    native!("__close", close);
    let context = v8::Context::new(handle_scope, v8::ContextOptions { global_template: Some(global), ..Default::default() });
    let scope = &mut v8::ContextScope::new(handle_scope, context);
    run(scope, PRELUDE, "prelude").expect("prelude");
    // a build from before the native engine has no host; exiting lets the studio keep its webview engine
    let Ok(host) = std::fs::read_to_string(DIST.get().unwrap().join("engine-host.js")) else {
        eprintln!("[engine] the served build has no engine-host.js, exiting");
        std::process::exit(1);
    };
    run(scope, &host, "engine-host.js").expect("engine host");
    run(scope, &processor_source(DIST.get().unwrap()), "wasm-processor.js").expect("wasm-processor");
    let open = bridge_function(scope, "open");
    let receive = bridge_function(scope, "receive");
    let close = bridge_function(scope, "close");
    let render = bridge_function(scope, "render");
    let timers = v8::Local::<v8::Function>::try_from(run(scope, "__timers", "timers").unwrap()).unwrap();
    let out = v8::Local::<v8::Float32Array>::try_from(run(scope, "new Float32Array(256)", "out").unwrap()).unwrap();
    let out_store = out.buffer(scope).unwrap().get_backing_store();
    let out_ptr = out_store.data().unwrap().as_ptr() as *const f32;
    let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
    let _priority = audio_thread_priority::promote_current_thread_to_real_time(QUANTUM as u32, sample_rate)
        .map_err(|error| println!("[engine] real-time priority failed: {error:?}")).ok();
    println!("[engine] ready, listening on 127.0.0.1:{PORT}");
    loop {
        while let Ok(event) = events.try_recv() {
            match event {
                Event::Open(id) => {
                    let id = v8::Integer::new(scope, id).into();
                    open.call(scope, receiver, &[id]);
                }
                Event::Receive(id, bytes) => {
                    let id = v8::Integer::new(scope, id).into();
                    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
                    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store).into();
                    receive.call(scope, receiver, &[id, buffer]);
                }
                Event::Close(id) => {
                    let id = v8::Integer::new(scope, id).into();
                    close.call(scope, receiver, &[id]);
                }
            }
        }
        while producer.slots() >= QUANTUM * 2 {
            render.call(scope, receiver, &[out.into()]);
            let samples = unsafe { std::slice::from_raw_parts(out_ptr, QUANTUM * 2) };
            producer.write_chunk_uninit(QUANTUM * 2).unwrap().fill_from_iter(samples.iter().copied());
        }
        while v8::Platform::pump_message_loop(&platform, scope, false) {}
        timers.call(scope, receiver, &[]);
        scope.perform_microtask_checkpoint();
        std::thread::park_timeout(Duration::from_millis(1));
    }
}

fn serve(events: Sender<Event>, token: String) {
    let listener = TcpListener::bind(("127.0.0.1", PORT)).expect("engine port taken");
    let mut next = 1;
    for stream in listener.incoming().flatten() {
        let id = next;
        next += 1;
        let (events, token) = (events.clone(), token.clone());
        std::thread::spawn(move || {
            let check = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
                let query = request.uri().query().unwrap_or("");
                if query.split('&').any(|pair| pair == format!("token={token}")) {
                    Ok(response)
                } else {
                    Err(Response::builder().status(403).body(None).unwrap())
                }
            };
            // decoded samples arrive as single messages of any size
            let config = tungstenite::protocol::WebSocketConfig::default().max_message_size(None).max_frame_size(None);
            let Ok(mut socket) = tungstenite::accept_hdr_with_config(stream, check, Some(config)) else { return };
            let _ = socket.get_ref().set_read_timeout(Some(Duration::from_millis(2)));
            let (sender, outgoing) = channel::<Option<Vec<u8>>>();
            outbox().lock().unwrap().insert(id, sender);
            let _ = events.send(Event::Open(id));
            'connection: loop {
                match socket.read() {
                    Ok(Message::Binary(bytes)) => {
                        let _ = events.send(Event::Receive(id, bytes.to_vec()));
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(error)) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                    Err(error) => {
                        println!("[engine] connection {id} ended: {error}");
                        break;
                    }
                }
                while let Ok(message) = outgoing.try_recv() {
                    match message {
                        Some(bytes) => {
                            if socket.send(Message::Binary(bytes.into())).is_err() { break 'connection; }
                        }
                        None => {
                            let _ = socket.close(None);
                            let _ = socket.flush();
                            break 'connection;
                        }
                    }
                }
            }
            outbox().lock().unwrap().remove(&id);
            let _ = events.send(Event::Close(id));
        });
    }
}

fn main() {
    STARTED.set(Instant::now()).unwrap();
    // the shell holds our stdin; when it goes away, so do we
    std::thread::spawn(|| {
        let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
        std::process::exit(0);
    });
    let dist = std::env::var("OPENDAW_DIST").map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../studio/dist-desktop")));
    DIST.set(dist).unwrap();
    let token = std::env::var("OPENDAW_ENGINE_TOKEN").unwrap_or_default();
    let ring_frames: usize = std::env::var("RING").ok().and_then(|value| value.parse().ok()).unwrap_or(256);
    let buffer: u32 = std::env::var("BUFFER").ok().and_then(|value| value.parse().ok()).unwrap_or(128);
    let sample_rate = 48_000;
    let device = cpal::default_host().default_output_device().expect("no output device");
    println!("[engine] output {:?}, buffer {buffer}, ring {ring_frames}", device.description().map(|description| description.name().to_string()));
    let (producer, mut consumer) = rtrb::RingBuffer::<f32>::new(ring_frames * 2);
    let (events, inbox) = channel();
    std::thread::spawn(move || serve(events, token));
    let engine = std::thread::Builder::new().name("engine".into())
        .spawn(move || engine_thread(inbox, producer, sample_rate)).unwrap();
    let waker = engine.thread().clone();
    let config = cpal::StreamConfig { channels: 2, sample_rate, buffer_size: cpal::BufferSize::Fixed(buffer) };
    let stream = device.build_output_stream(config, move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
        let available = consumer.slots().min(data.len());
        if let Ok(chunk) = consumer.read_chunk(available) {
            let (first, second) = chunk.as_slices();
            data[..first.len()].copy_from_slice(first);
            data[first.len()..first.len() + second.len()].copy_from_slice(second);
            chunk.commit_all();
        }
        data[available..].fill(0.0);
        waker.unpark();
    }, |error| eprintln!("[engine] audio {error}"), None).expect("output stream");
    stream.play().expect("play");
    engine.join().unwrap();
}

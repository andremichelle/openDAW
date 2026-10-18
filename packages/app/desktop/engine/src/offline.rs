// Offline renders (mixdown, stems, freeze): each studio connection on `/offline` gets a thread and an isolate of
// its own running offline-host.js and the studio's unchanged wasm-offline-worker bundle, never the audio thread
use std::cell::RefCell;
use std::net::TcpStream;
use std::time::{Duration, Instant};

use tungstenite::{Message, WebSocket};

use crate::{arg_string, dist, native_load, native_note, native_param, native_process, native_process_effect, native_release, native_reset, native_state, now,
            platform, plugins, print, read, run, PRELUDE};

const TICK: Duration = Duration::from_millis(8);

thread_local! {
    static OUTGOING: RefCell<Vec<Vec<u8>>> = const { RefCell::new(Vec::new()) };
}

fn offline_send(_scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(args.get(0)) else { return };
    let length = buffer.byte_length();
    let bytes = match buffer.get_backing_store().data() {
        Some(data) if length > 0 => unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, length) }.to_vec(),
        _ => Vec::new(),
    };
    OUTGOING.with(|outgoing| outgoing.borrow_mut().push(bytes));
}

// a plugin copy of this render, at the render's sample rate (the worker sets the global before the engine starts)
fn native_create(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let uuid = arg_string(scope, &args, 0);
    let key = v8::String::new(scope, "sampleRate").unwrap();
    let sample_rate = scope.get_current_context().global(scope).get(scope, key.into())
        .and_then(|value| value.number_value(scope)).filter(|rate| *rate > 0.0).unwrap_or(48_000.0);
    rv.set_uint32(plugins::create_offline_slot(uuid, sample_rate));
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = bytes.get(index + 1..index + 3).and_then(|pair| std::str::from_utf8(pair).ok())
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match (bytes[index], hex) {
            (b'%', Some(byte)) => {
                decoded.push(byte);
                index += 3;
            }
            (byte, _) => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn worker_source(query: &str) -> Option<String> {
    let url = query.split('&').find_map(|pair| pair.strip_prefix("worker=")).map(decode)?;
    let path = url.split(['?', '#']).next()?;
    let path = match path.split_once("://") {
        Some((_, rest)) => rest.split_once('/')?.1,
        None => path.trim_start_matches('/'),
    };
    if path.contains("..") { return None; }
    std::fs::read_to_string(dist().join(path)).ok().map(|source| source.replace("import.meta.url", "self.location.href"))
}

pub fn serve(mut socket: WebSocket<TcpStream>, query: &str) {
    let Some(worker) = worker_source(query) else {
        eprintln!("[offline] no offline worker bundle for {query}");
        return;
    };
    let Ok(host) = std::fs::read_to_string(dist().join("offline-host.js")) else {
        eprintln!("[offline] the served build has no offline-host.js");
        return;
    };
    crate::poll::poll(&socket);
    let platform = platform();
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
    native!("__offlineSend", offline_send);
    native!("__nativeCreate", native_create);
    native!("__nativeLoad", native_load);
    native!("__nativeProcess", native_process);
    native!("__nativeProcessEffect", native_process_effect);
    native!("__nativeNote", native_note);
    native!("__nativeState", native_state);
    native!("__nativeParam", native_param);
    native!("__nativeReset", native_reset);
    native!("__nativeRelease", native_release);
    let context = v8::Context::new(handle_scope, v8::ContextOptions { global_template: Some(global), ..Default::default() });
    let scope = &mut v8::ContextScope::new(handle_scope, context);
    run(scope, PRELUDE, "prelude").expect("prelude");
    if run(scope, &host, "offline-host.js").is_none() || run(scope, &worker, "wasm-offline-worker.js").is_none() { return; }
    let function = |scope: &mut v8::PinScope, name: &str| -> Option<v8::Global<v8::Function>> {
        let value = run(scope, name, name)?;
        v8::Local::<v8::Function>::try_from(value).ok().map(|function| v8::Global::new(scope, function))
    };
    let (Some(receive), Some(tick), Some(timers)) = (function(scope, "__offline.receive"), function(scope, "__offline.tick"),
        function(scope, "__timers")) else { return };
    println!("[offline] render started");
    let mut last_tick = Instant::now();
    'render: loop {
        loop {
            match crate::poll::read(&mut socket, Duration::from_millis(1)) {
                Ok(Some(Message::Binary(bytes))) => {
                    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes.to_vec()).make_shared();
                    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store).into();
                    let receiver = v8::undefined(scope).into();
                    v8::Local::new(scope, &receive).call(scope, receiver, &[buffer]);
                }
                Ok(Some(Message::Close(_))) => {
                    let _ = socket.flush();
                    break 'render;
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => break 'render,
            }
        }
        while v8::Platform::pump_message_loop(platform, scope, false) {}
        let receiver = v8::undefined(scope).into();
        v8::Local::new(scope, &timers).call(scope, receiver, &[]);
        scope.perform_microtask_checkpoint();
        if last_tick.elapsed() >= TICK {
            last_tick = Instant::now();
            v8::Local::new(scope, &tick).call(scope, receiver, &[]);
        }
        for bytes in OUTGOING.with(|outgoing| std::mem::take(&mut *outgoing.borrow_mut())) {
            if crate::poll::send(&mut socket, Message::Binary(bytes.into())).is_err() { break 'render; }
        }
    }
    plugins::release_thread_slots();
    println!("[offline] render finished");
}

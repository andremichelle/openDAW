// The native engine process: embedded V8 runs the studio's unchanged wasm-processor bundle, cpal plays it,
// and every studio engine instance talks to it over one loopback WebSocket
use std::collections::HashMap;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

mod audio;
mod midi;
mod offline;
mod plugins;
mod scan;
mod stats;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::Message;

const QUANTUM: usize = 128;
const INPUT_CHANNELS: usize = 8;
const PORT: u16 = 47112;
pub(crate) const PRELUDE: &str = r#"
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
pub(crate) static SAMPLE_RATE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(48_000);
// output latency parts in microseconds: the ring's depth and what the device reports between callback and playback
static RING_LATENCY_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static DEVICE_LATENCY_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static INPUT_LATENCY_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
// what waits in the input ring after a pull, in microseconds
static INPUT_RING_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
// the main thread owns the cpal input stream (not Send) and opens it on request
// requests for the main thread, which owns the cpal streams (not Send)
pub enum MainRequest {
    // Some(name) opens that input ("" = the default), None closes it
    Input(Option<String>),
    // device name ("" = the default) and buffer size in frames
    Output(String, u32),
    // work that must run on the main thread (native plugins and their windows)
    Run(Box<dyn FnOnce() + Send>),
}

static MAIN_REQUESTS: Mutex<Option<Sender<MainRequest>>> = Mutex::new(None);
const RING_CAPACITY_FRAMES: usize = 8192;
// the engine keeps this many frames rendered ahead of the output callback
static RING_TARGET_FRAMES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(256);
// "\n"-separated output device names, refreshed in the background, and the open output with its buffer size
pub static OUTPUT_DEVICES: Mutex<String> = Mutex::new(String::new());
pub static OUTPUT_CURRENT: Mutex<(String, u32)> = Mutex::new((String::new(), 128));
pub static OUTPUT_NAME: Mutex<String> = Mutex::new(String::new());
// "name\tchannels" lines of the available inputs, refreshed in the background
static INPUT_DEVICES: Mutex<String> = Mutex::new(String::new());
static INPUT_INFO: Mutex<Option<(String, usize)>> = Mutex::new(None);
static OUTBOX: OnceLock<Mutex<HashMap<i32, Sender<Option<Vec<u8>>>>>> = OnceLock::new();

enum Event {
    Open(i32),
    Receive(i32, Vec<u8>),
    Close(i32),
    Input(Option<(rtrb::Consumer<f32>, usize)>),
}

struct Input {
    consumer: rtrb::Consumer<f32>,
    channels: usize,
}

fn outbox() -> &'static Mutex<HashMap<i32, Sender<Option<Vec<u8>>>>> {
    OUTBOX.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn print(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let parts: Vec<String> = (0..args.length()).map(|index| args.get(index).to_rust_string_lossy(scope)).collect();
    println!("[js] {}", parts.join(" "));
}

pub(crate) fn now(_scope: &mut v8::PinScope, _args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    rv.set_double(STARTED.get().unwrap().elapsed().as_secs_f64() * 1000.0);
}

pub(crate) fn read(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
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

fn output_latency(_scope: &mut v8::PinScope, _args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let ordering = std::sync::atomic::Ordering::Relaxed;
    rv.set_double((RING_LATENCY_US.load(ordering) + DEVICE_LATENCY_US.load(ordering)) as f64 / 1_000_000.0);
}

// a request to the shell's own endpoints, which want the token the shell gave us
#[cfg(target_os = "macos")]
pub(crate) fn tell_shell(path: String) {
    let token = std::env::var("OPENDAW_ENGINE_TOKEN").unwrap_or_default();
    let separator = if path.contains('?') { '&' } else { '?' };
    std::thread::spawn(move || {
        use std::io::Write;
        if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", 47110)) {
            let _ = stream.write_all(format!("GET {path}{separator}token={token} HTTP/1.0\r\n\r\n").as_bytes());
        }
    });
}

pub fn request_main(request: MainRequest) {
    if let Some(sender) = MAIN_REQUESTS.lock().unwrap().as_ref() {
        let _ = sender.send(request);
    }
}

fn request_input(request: Option<String>) {request_main(MainRequest::Input(request))}

fn open_input(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    request_input(Some(args.get(0).to_rust_string_lossy(scope)))
}

fn close_input(_scope: &mut v8::PinScope, _args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {request_input(None)}

fn input_devices(scope: &mut v8::PinScope, _args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let devices = INPUT_DEVICES.lock().unwrap().clone();
    rv.set(v8::String::new(scope, &devices).unwrap().into());
}

fn device_name(device: &cpal::Device) -> String {
    device.description().map(|description| description.name().to_string()).unwrap_or_default()
}

fn list_input_devices() -> String {
    let Ok(devices) = cpal::default_host().input_devices() else { return String::new() };
    devices.filter_map(|device| {
        let channels = device.default_input_config().ok()?.channels();
        Some(format!("{}\t{channels}", device_name(&device)))
    }).collect::<Vec<_>>().join("\n")
}

// "name\tchannels" of the open input, or an empty string
fn input_info(scope: &mut v8::PinScope, _args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let info = INPUT_INFO.lock().unwrap().as_ref().map(|(name, channels)| format!("{name}\t{channels}")).unwrap_or_default();
    rv.set(v8::String::new(scope, &info).unwrap().into());
}

fn input_latency(_scope: &mut v8::PinScope, _args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let ordering = std::sync::atomic::Ordering::Relaxed;
    rv.set_double((INPUT_LATENCY_US.load(ordering) + INPUT_RING_US.load(ordering)) as f64 / 1_000_000.0);
}

fn arg_u32(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, index: i32) -> u32 {
    args.get(index).uint32_value(scope).unwrap_or(0)
}

pub(crate) fn arg_string(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, index: i32) -> String {
    args.get(index).to_rust_string_lossy(scope)
}

fn native_create(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let uuid = arg_string(scope, &args, 0);
    rv.set_uint32(plugins::create_slot(uuid));
}

pub(crate) fn native_load(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let (handle, format, id) = (arg_u32(scope, &args, 0), arg_string(scope, &args, 1), arg_string(scope, &args, 2));
    plugins::load(handle, format, id, SAMPLE_RATE.load(std::sync::atomic::Ordering::Relaxed) as f64);
}

// (handle, memory buffer, left pointer, right pointer, frames, bpm, position, flags) -> 1 when the plugin wrote output
pub(crate) fn native_process(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let handle = arg_u32(scope, &args, 0);
    let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(args.get(1)) else { return rv.set_uint32(0) };
    let (left, right, frames) = (arg_u32(scope, &args, 2) as usize, arg_u32(scope, &args, 3) as usize, arg_u32(scope, &args, 4) as usize);
    let bpm = args.get(5).number_value(scope).unwrap_or(120.0) as f32;
    let position = args.get(6).number_value(scope).unwrap_or(0.0);
    let flags = arg_u32(scope, &args, 7);
    let store = buffer.get_backing_store();
    let Some(base) = store.data() else { return rv.set_uint32(0) };
    let length = store.byte_length();
    if left + frames * 4 > length || right + frames * 4 > length { return rv.set_uint32(0); }
    let base = base.as_ptr() as *mut u8;
    let wrote = unsafe { plugins::process(handle, None, base.add(left) as *mut f32, base.add(right) as *mut f32, frames, bpm, position, flags) };
    rv.set_uint32(wrote as u32);
}

// (handle, memory buffer, input left, input right, output left, output right, frames, bpm, position, flags) -> 1 when
// the plugin wrote output
pub(crate) fn native_process_effect(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let handle = arg_u32(scope, &args, 0);
    let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(args.get(1)) else { return rv.set_uint32(0) };
    let pointers = [2, 3, 4, 5].map(|index| arg_u32(scope, &args, index) as usize);
    let frames = arg_u32(scope, &args, 6) as usize;
    let bpm = args.get(7).number_value(scope).unwrap_or(120.0) as f32;
    let position = args.get(8).number_value(scope).unwrap_or(0.0);
    let flags = arg_u32(scope, &args, 9);
    let store = buffer.get_backing_store();
    let Some(base) = store.data() else { return rv.set_uint32(0) };
    if pointers.iter().any(|pointer| pointer + frames * 4 > store.byte_length()) { return rv.set_uint32(0); }
    let [in_left, in_right, out_left, out_right] = pointers.map(|pointer| unsafe { (base.as_ptr() as *mut u8).add(pointer) as *mut f32 });
    let wrote = unsafe { plugins::process(handle, Some((in_left, in_right)), out_left, out_right, frames, bpm, position, flags) };
    rv.set_uint32(wrote as u32);
}

pub(crate) fn native_note(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let (handle, on, key) = (arg_u32(scope, &args, 0), arg_u32(scope, &args, 1) != 0, arg_u32(scope, &args, 2) as i16);
    let velocity = args.get(3).number_value(scope).unwrap_or(1.0) as f32;
    plugins::note(handle, on, key, velocity);
}

pub(crate) fn native_param(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let (handle, id, kind) = (arg_u32(scope, &args, 0), arg_u32(scope, &args, 1), arg_u32(scope, &args, 2));
    let value = args.get(3).number_value(scope).unwrap_or(0.0) as f32;
    let modulation = args.get(4).number_value(scope).unwrap_or(f64::NAN) as f32;
    plugins::param(handle, id, kind, value, modulation);
}

pub(crate) fn native_state(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let handle = arg_u32(scope, &args, 0);
    let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(args.get(1)) else { return };
    let store = buffer.get_backing_store();
    let state = store.data().map(|data| unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, store.byte_length()) }.to_vec())
        .unwrap_or_default();
    plugins::set_state(handle, state);
}

pub(crate) fn native_reset(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    plugins::reset(arg_u32(scope, &args, 0));
}

pub(crate) fn native_release(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    plugins::release(arg_u32(scope, &args, 0));
}

fn native_open_gui(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    if let Some(handle) = plugins::handle_of(&arg_string(scope, &args, 0)) { plugins::open_gui(handle); }
}

fn native_close_gui(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    if let Some(handle) = plugins::handle_of(&arg_string(scope, &args, 0)) { plugins::close_gui(handle); }
}

fn native_save_all(_scope: &mut v8::PinScope, _args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    plugins::save_all();
}

fn close(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let id = args.get(0).int32_value(scope).unwrap_or(-1);
    if let Some(sender) = outbox().lock().unwrap().remove(&id) {
        let _ = sender.send(None);
    }
}

pub(crate) fn run<'s>(scope: &mut v8::PinScope<'s, '_>, source: &str, name: &str) -> Option<v8::Local<'s, v8::Value>> {
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

static PLATFORM: OnceLock<v8::SharedRef<v8::Platform>> = OnceLock::new();

// V8 is initialised once per process, the engine thread and every offline render share the platform
pub(crate) fn platform() -> &'static v8::SharedRef<v8::Platform> {
    PLATFORM.get_or_init(|| {
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform.clone());
        v8::V8::initialize();
        platform
    })
}

pub(crate) fn dist() -> &'static PathBuf {DIST.get().unwrap()}

fn engine_thread(events: Receiver<Event>, mut producer: rtrb::Producer<f32>, sample_rate: u32) {
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
    native!("__send", send);
    native!("__close", close);
    native!("__outputLatency", output_latency);
    native!("__openInput", open_input);
    native!("__closeInput", close_input);
    native!("__inputInfo", input_info);
    native!("__inputLatency", input_latency);
    native!("__inputDevices", input_devices);
    native!("__nativeCreate", native_create);
    native!("__nativeLoad", native_load);
    native!("__nativeProcess", native_process);
    native!("__nativeProcessEffect", native_process_effect);
    native!("__nativeNote", native_note);
    native!("__nativeState", native_state);
    native!("__nativeParam", native_param);
    native!("__nativeReset", native_reset);
    native!("__nativeRelease", native_release);
    native!("__nativeOpenGui", native_open_gui);
    native!("__nativeCloseGui", native_close_gui);
    native!("__nativeSaveAll", native_save_all);
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
    let input_array = v8::Local::<v8::Float32Array>::try_from(run(scope, &format!("new Float32Array({})", INPUT_CHANNELS * QUANTUM), "input").unwrap()).unwrap();
    let input_store = input_array.buffer(scope).unwrap().get_backing_store();
    let input_ptr = input_store.data().unwrap().as_ptr() as *mut f32;
    let mut input: Option<Input> = None;
    let mut interleaved = vec![0.0f32; INPUT_CHANNELS * QUANTUM];
    let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
    let _priority = audio_thread_priority::promote_current_thread_to_real_time(QUANTUM as u32, sample_rate)
        .map_err(|error| println!("[engine] real-time priority failed: {error:?}")).ok();
    println!("[engine] ready, listening on 127.0.0.1:{PORT}");
    loop {
        let received = Instant::now();
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
                Event::Input(next) => input = next.map(|(consumer, channels)| Input { consumer, channels }),
            }
        }
        stats::record_max(&stats::MAX_RECEIVE_US, received);
        let capacity = producer.buffer().capacity();
        while capacity - producer.slots() < RING_TARGET_FRAMES.load(std::sync::atomic::Ordering::Relaxed) * 2 {
            let planar = unsafe { std::slice::from_raw_parts_mut(input_ptr, INPUT_CHANNELS * QUANTUM) };
            let channels = pull_input(&mut input, &mut interleaved, planar);
            let channels = v8::Integer::new(scope, channels as i32).into();
            let started = Instant::now();
            render.call(scope, receiver, &[out.into(), input_array.into(), channels]);
            stats::record_max(&stats::MAX_RENDER_US, started);
            let samples = unsafe { std::slice::from_raw_parts(out_ptr, QUANTUM * 2) };
            producer.write_chunk_uninit(QUANTUM * 2).unwrap().fill_from_iter(samples.iter().copied());
        }
        stats::report();
        let idle = Instant::now();
        while v8::Platform::pump_message_loop(platform, scope, false) {}
        timers.call(scope, receiver, &[]);
        scope.perform_microtask_checkpoint();
        stats::record_max(&stats::MAX_TIMERS_US, idle);
        std::thread::park_timeout(Duration::from_millis(1));
    }
}

// Moves one quantum from the input ring into planar channels. A ring that ran ahead (clock drift between the
// input and output devices) is trimmed to keep the input latency bounded; an empty one yields silence.
fn pull_input(input: &mut Option<Input>, interleaved: &mut [f32], planar: &mut [f32]) -> usize {
    planar.fill(0.0);
    let Some(Input { consumer, channels }) = input.as_mut() else { return 0 };
    let channels = *channels;
    let quantum = QUANTUM * channels;
    while consumer.slots() >= quantum * 4 {
        if let Ok(chunk) = consumer.read_chunk(quantum) { chunk.commit_all(); }
    }
    if consumer.slots() < quantum { return channels.min(INPUT_CHANNELS); }
    if let Ok(chunk) = consumer.read_chunk(quantum) {
        let (first, second) = chunk.as_slices();
        interleaved[..first.len()].copy_from_slice(first);
        interleaved[first.len()..quantum].copy_from_slice(second);
        chunk.commit_all();
    }
    for frame in 0..QUANTUM {
        for channel in 0..channels.min(INPUT_CHANNELS) {
            planar[channel * QUANTUM + frame] = interleaved[frame * channels + channel];
        }
    }
    let waiting = (consumer.slots() / channels + QUANTUM) as u64;
    INPUT_RING_US.store(waiting * 1_000_000 / 48_000, std::sync::atomic::Ordering::Relaxed);
    channels.min(INPUT_CHANNELS)
}

// Opens the default input at the engine's rate; the stream lives as long as the returned value
fn open_input_stream(events: &Sender<Event>, sample_rate: u32, requested: &str) -> Option<cpal::Stream> {
    let host = cpal::default_host();
    let chosen = host.input_devices().ok().and_then(|mut devices| devices.find(|device| !requested.is_empty() && device_name(device) == requested));
    let device = chosen.or_else(|| host.default_input_device())?;
    let channels = device.default_input_config().ok()?.channels() as usize;
    let name = device_name(&device);
    let (mut producer, consumer) = rtrb::RingBuffer::<f32>::new(QUANTUM * channels * 16);
    let buffer_size = device.default_input_config().map(|config| buffer_size_for(config.buffer_size(), QUANTUM as u32))
        .unwrap_or(cpal::BufferSize::Default);
    let config = cpal::StreamConfig { channels: channels as u16, sample_rate, buffer_size };
    let stream = device.build_input_stream(config, move |data: &[f32], info: &cpal::InputCallbackInfo| {
        let timestamp = info.timestamp();
        INPUT_LATENCY_US.store(timestamp.callback.duration_since(timestamp.capture).as_micros() as u64, std::sync::atomic::Ordering::Relaxed);
        let count = producer.slots().min(data.len());
        if let Ok(chunk) = producer.write_chunk_uninit(count) {
            chunk.fill_from_iter(data[..count].iter().copied());
        }
    }, |error| eprintln!("[engine] input {error}"), None);
    match stream {
        Ok(stream) => {
            if let Err(error) = cpal::traits::StreamTrait::play(&stream) {
                eprintln!("[engine] input {error}");
                return None;
            }
            println!("[engine] input {name}, {channels} channels");
            *INPUT_INFO.lock().unwrap() = Some((name, channels));
            let _ = events.send(Event::Input(Some((consumer, channels))));
            Some(stream)
        }
        Err(error) => {
            eprintln!("[engine] cannot open input {name} at {sample_rate} Hz: {error}");
            None
        }
    }
}

// A fixed size the device does not support (WASAPI in shared mode) falls back to the device's own buffer
fn buffer_size_for(supported: &cpal::SupportedBufferSize, frames: u32) -> cpal::BufferSize {
    match supported {
        cpal::SupportedBufferSize::Range { min, max } if (*min..=*max).contains(&frames) => cpal::BufferSize::Fixed(frames),
        cpal::SupportedBufferSize::Range { .. } => {
            eprintln!("[engine] buffer size {frames} unsupported, using the device default");
            cpal::BufferSize::Default
        }
        cpal::SupportedBufferSize::Unknown => cpal::BufferSize::Fixed(frames),
    }
}

fn list_output_devices() -> String {
    let Ok(devices) = cpal::default_host().output_devices() else { return String::new() };
    devices.map(|device| device_name(&device)).filter(|name| !name.is_empty()).collect::<Vec<_>>().join("\n")
}

// Opens the named output ("" or unknown = the default) at the given buffer size; the ring target follows it
// asked of every output; a card that refuses runs at its own rate, the studio then restarts its engines at that rate
const REQUESTED_RATE: u32 = 48_000;

fn open_output_stream(requested: &str, buffer: u32, consumer: Arc<Mutex<rtrb::Consumer<f32>>>,
                      waker: std::thread::Thread) -> Option<cpal::Stream> {
    let host = cpal::default_host();
    let chosen = host.output_devices().ok().and_then(|mut devices| devices.find(|device| !requested.is_empty() && device_name(device) == requested));
    let device = chosen.or_else(|| host.default_output_device())?;
    let name = device_name(&device);
    let default_config = device.default_output_config().ok();
    let buffer_size = default_config.as_ref().map(|config| buffer_size_for(config.buffer_size(), buffer)).unwrap_or(cpal::BufferSize::Default);
    let own_rate = default_config.as_ref().map(|config| config.sample_rate()).filter(|rate| *rate != REQUESTED_RATE);
    let (stream, sample_rate) = match build_output(&device, REQUESTED_RATE, buffer_size, consumer.clone(), waker.clone()) {
        Ok(stream) => (stream, REQUESTED_RATE),
        Err(error) => match own_rate {
            Some(rate) => {
                eprintln!("[engine] output {name} refuses {REQUESTED_RATE} Hz ({error}), using its own {rate} Hz");
                match build_output(&device, rate, buffer_size, consumer, waker) {
                    Ok(stream) => (stream, rate),
                    Err(error) => {
                        eprintln!("[engine] cannot open output {name} with buffer {buffer}: {error}");
                        return None;
                    }
                }
            }
            None => {
                eprintln!("[engine] cannot open output {name} with buffer {buffer}: {error}");
                return None;
            }
        },
    };
    if let Err(error) = stream.play() {
        eprintln!("[engine] output {error}");
        return None;
    }
    SAMPLE_RATE.store(sample_rate, std::sync::atomic::Ordering::Relaxed);
    let target = (buffer as usize * 2).max(256);
    RING_TARGET_FRAMES.store(target, std::sync::atomic::Ordering::Relaxed);
    RING_LATENCY_US.store(target as u64 * 1_000_000 / sample_rate as u64, std::sync::atomic::Ordering::Relaxed);
    println!("[engine] output {name}, {sample_rate} Hz, buffer {buffer}, {target} frames ahead");
    *OUTPUT_CURRENT.lock().unwrap() = (requested.to_string(), buffer);
    *OUTPUT_NAME.lock().unwrap() = name;
    Some(stream)
}

fn build_output(device: &cpal::Device, sample_rate: u32, buffer_size: cpal::BufferSize, consumer: Arc<Mutex<rtrb::Consumer<f32>>>,
                waker: std::thread::Thread) -> Result<cpal::Stream, cpal::Error> {
    let config = cpal::StreamConfig { channels: 2, sample_rate, buffer_size };
    device.build_output_stream(config, move |data: &mut [f32], info: &cpal::OutputCallbackInfo| {
        // a card may ask for more per callback than requested (WASAPI and ALSA often do), the reserve follows it
        let current = RING_TARGET_FRAMES.load(std::sync::atomic::Ordering::Relaxed);
        if let Some(target) = raised_ring_target(current, data.len() / 2) {
            RING_TARGET_FRAMES.store(target, std::sync::atomic::Ordering::Relaxed);
            RING_LATENCY_US.store(target as u64 * 1_000_000 / sample_rate as u64, std::sync::atomic::Ordering::Relaxed);
        }
        let timestamp = info.timestamp();
        DEVICE_LATENCY_US.store(timestamp.playback.duration_since(timestamp.callback).as_micros() as u64, std::sync::atomic::Ordering::Relaxed);
        // the main thread holds the lock only while it swaps streams
        let available = match consumer.try_lock() {
            Ok(mut consumer) => {
                let available = consumer.slots().min(data.len());
                if let Ok(chunk) = consumer.read_chunk(available) {
                    let (first, second) = chunk.as_slices();
                    data[..first.len()].copy_from_slice(first);
                    data[first.len()..first.len() + second.len()].copy_from_slice(second);
                    chunk.commit_all();
                }
                available
            }
            Err(_) => 0,
        };
        if available < data.len() { stats::count(&stats::UNDERRUNS); }
        data[available..].fill(0.0);
        waker.unpark();
    }, |error| eprintln!("[engine] audio {error}"), None)
}

// the frames kept ready: two of the card's callbacks, within the ring
fn raised_ring_target(current: usize, callback_frames: usize) -> Option<usize> {
    let wanted = (callback_frames * 2).min(RING_CAPACITY_FRAMES / 2);
    (wanted > current).then_some(wanted)
}

// only the studio's pages connect: its origin and the token the shell gave both of us
const STUDIO_ORIGIN: &str = "http://127.0.0.1:47110";

fn accepts(query: &str, origin: Option<&str>, token: &str) -> bool {
    !token.is_empty() && origin == Some(STUDIO_ORIGIN) && query.split('&').any(|pair| pair.strip_prefix("token=") == Some(token))
}

fn serve(events: Sender<Event>, token: String) {
    let listener = TcpListener::bind(("127.0.0.1", PORT)).expect("engine port taken");
    let mut next = 1;
    for stream in listener.incoming().flatten() {
        let id = next;
        next += 1;
        let (events, token) = (events.clone(), token.clone());
        std::thread::spawn(move || {
            let mut path = String::new();
            let mut query = String::new();
            let check = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
                path = request.uri().path().to_string();
                query = request.uri().query().unwrap_or("").to_string();
                let origin = request.headers().get("Origin").and_then(|value| value.to_str().ok());
                if accepts(&query, origin, &token) {
                    Ok(response)
                } else {
                    Err(Response::builder().status(403).body(None).unwrap())
                }
            };
            // decoded samples arrive as single messages of any size
            let config = tungstenite::protocol::WebSocketConfig::default().max_message_size(None).max_frame_size(None);
            let Ok(mut socket) = tungstenite::accept_hdr_with_config(stream, check, Some(config)) else { return };
            if path == "/midi" {
                return midi::serve(socket);
            }
            if path == "/native" {
                return plugins::serve_notices(socket);
            }
            if path == "/audio" {
                return audio::serve(socket);
            }
            if path == "/offline" {
                return offline::serve(socket, &query);
            }
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
                            // waits briefly for the studio's answer, a dropped connection would look like a crash there
                            let _ = socket.close(None);
                            let _ = socket.flush();
                            let deadline = Instant::now() + Duration::from_millis(250);
                            while Instant::now() < deadline {
                                match socket.read() {
                                    Err(tungstenite::Error::Io(error)) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                                    Err(_) => break,
                                    Ok(_) => {}
                                }
                            }
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
    if let [_, flag, bundle] = std::env::args().collect::<Vec<_>>().as_slice() {
        if flag == "--scan" { scan::scan_process(bundle); }
    }
    STARTED.set(Instant::now()).unwrap();
    // plugin editors measure in pixels, the windows must not be stretched by Windows
    #[cfg(target_os = "windows")]
    unsafe { windows_sys::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(windows_sys::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); }
    // the shell holds our stdin and sends commands on it; when it goes away, so do we
    std::thread::spawn(|| {
        use std::io::BufRead;
        for line in std::io::stdin().lock().lines() {
            match line.as_deref() {
                Ok("cycle") => plugins::cycle_in(),
                Ok(_) => {}
                Err(_) => break,
            }
        }
        std::process::exit(0);
    });
    let dist = std::env::var("OPENDAW_DIST").map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../studio/dist-desktop")));
    DIST.set(dist).unwrap();
    let token = std::env::var("OPENDAW_ENGINE_TOKEN").unwrap_or_default();
    if token.is_empty() {
        eprintln!("[engine] started without a token (OPENDAW_ENGINE_TOKEN), exiting");
        std::process::exit(1);
    }
    let buffer: u32 = std::env::var("BUFFER").ok().and_then(|value| value.parse().ok()).unwrap_or(128);
    let sample_rate = REQUESTED_RATE;
    let (producer, consumer) = rtrb::RingBuffer::<f32>::new(RING_CAPACITY_FRAMES * 2);
    let consumer = Arc::new(Mutex::new(consumer));
    let (events, inbox) = channel();
    let input_events = events.clone();
    std::thread::spawn(move || serve(events, token));
    let engine = std::thread::Builder::new().name("engine".into())
        .spawn(move || engine_thread(inbox, producer, sample_rate)).unwrap();
    let waker = engine.thread().clone();
    let mut output_stream = Some(open_output_stream("", buffer, consumer.clone(), waker.clone()).expect("no output device"));
    std::thread::spawn(|| loop {
        *INPUT_DEVICES.lock().unwrap() = list_input_devices();
        *OUTPUT_DEVICES.lock().unwrap() = list_output_devices();
        std::thread::sleep(Duration::from_secs(2));
    });
    let (requests, incoming) = channel::<MainRequest>();
    *MAIN_REQUESTS.lock().unwrap() = Some(requests);
    let mut input_stream: Option<(cpal::Stream, String)> = None;
    let mut handle = move |request: MainRequest| {
        let request = match request {
            MainRequest::Output(device, size) => {
                if *OUTPUT_CURRENT.lock().unwrap() == (device.clone(), size) { return; }
                drop(output_stream.take());
                output_stream = Some(open_output_stream(&device, size, consumer.clone(), waker.clone())
                    .or_else(|| open_output_stream("", 128, consumer.clone(), waker.clone()))
                    .expect("no output device"));
                return;
            }
            MainRequest::Run(work) => return work(),
            MainRequest::Input(request) => request,
        };
        match request {
            Some(requested) => {
                if input_stream.as_ref().is_some_and(|(_, current)| *current == requested) { return; }
                drop(input_stream.take());
                input_stream = open_input_stream(&input_events, SAMPLE_RATE.load(std::sync::atomic::Ordering::Relaxed), &requested)
                    .map(|stream| (stream, requested));
            }
            None if input_stream.is_some() => {
                input_stream = None;
                *INPUT_INFO.lock().unwrap() = None;
                let _ = input_events.send(Event::Input(None));
                println!("[engine] input closed");
            }
            None => {}
        }
    };
    #[cfg(target_os = "macos")]
    run_main_loop(move || {
        while let Ok(request) = incoming.try_recv() { handle(request); }
        plugins::tick();
    });
    #[cfg(target_os = "windows")]
    run_main_loop(move || {
        while let Ok(request) = incoming.try_recv() { handle(request); }
        plugins::tick();
    });
    #[cfg(target_os = "linux")]
    loop {
        plugins::pump(Duration::from_millis(5));
        while let Ok(request) = incoming.try_recv() { handle(request); }
        plugins::tick();
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    for request in incoming { handle(request); }
}

// plugin windows need a Windows message loop on this thread; it wakes for messages or every 5 ms for the requests
#[cfg(target_os = "windows")]
fn run_main_loop(mut tick: impl FnMut()) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{DispatchMessageW, MsgWaitForMultipleObjects, PeekMessageW, TranslateMessage,
                                                     MSG, PM_REMOVE, QS_ALLINPUT};
    loop {
        let mut message: MSG = unsafe { std::mem::zeroed() };
        while unsafe { PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) } != 0 {
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        tick();
        unsafe { MsgWaitForMultipleObjects(0, std::ptr::null(), 0, 5, QS_ALLINPUT); }
    }
}

// plugin windows need the main thread's run loop, the requests are handled from a timer on it
#[cfg(target_os = "macos")]
fn run_main_loop(tick: impl FnMut() + 'static) {
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop, CFRunLoopTimer, CFRunLoopTimerRef};
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
    thread_local! {
        static TICK: std::cell::RefCell<Option<Box<dyn FnMut()>>> = std::cell::RefCell::new(None);
    }
    extern "C" fn fire(_timer: CFRunLoopTimerRef, _info: *mut std::ffi::c_void) {
        TICK.with(|tick| if let Some(tick) = tick.borrow_mut().as_mut() { tick() });
    }
    TICK.with(|slot| *slot.borrow_mut() = Some(Box::new(tick)));
    let mtm = objc2::MainThreadMarker::new().expect("main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    let timer = CFRunLoopTimer::new(0.0, 0.005, 0, 0, fire, std::ptr::null_mut());
    unsafe { CFRunLoop::get_main().add_timer(&timer, kCFRunLoopCommonModes); }
    app.run();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reserve_follows_the_cards_callback_size() {
        assert_eq!(raised_ring_target(256, 128), None);
        assert_eq!(raised_ring_target(256, 480), Some(960));
        assert_eq!(raised_ring_target(960, 480), None);
        assert_eq!(raised_ring_target(256, 1056), Some(2112));
        assert_eq!(raised_ring_target(256, 16_384), Some(RING_CAPACITY_FRAMES / 2));
    }

    #[test]
    fn only_the_studio_with_the_token_connects() {
        assert!(accepts("token=abc", Some(STUDIO_ORIGIN), "abc"));
        assert!(accepts("worker=%2Fx.js&token=abc", Some(STUDIO_ORIGIN), "abc"));
        assert!(!accepts("token=abc", None, "abc"));
        assert!(!accepts("token=abc", Some("https://evil.example"), "abc"));
        assert!(!accepts("token=abd", Some(STUDIO_ORIGIN), "abc"));
        assert!(!accepts("token=", Some(STUDIO_ORIGIN), ""));
        assert!(!accepts("", Some(STUDIO_ORIGIN), ""));
    }
}

// Spike: the real wasm engine in embedded V8, rendered on an engine thread into a ring that cpal plays
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

const QUANTUM: usize = 128;
const HOST: &str = include_str!(concat!(env!("OUT_DIR"), "/host.js"));
const PRELUDE: &str = r#"
    globalThis.console = {log: (...args) => __print(args.join(" ")), debug: () => {}, info: (...args) => __print(args.join(" ")),
        warn: (...args) => __print("warn " + args.join(" ")), error: (...args) => __print("error " + args.join(" "))}
    globalThis.crypto = {getRandomValues: array => {for (let index = 0; index < array.length; index++) {array[index] = Math.random() * 256 | 0} return array}}
    globalThis.fetch = async url => {
        const bytes = __read(url)
        return {ok: bytes !== undefined, status: bytes === undefined ? 404 : 200, statusText: "", arrayBuffer: async () => bytes}
    }
"#;

static DIST: OnceLock<PathBuf> = OnceLock::new();

#[derive(Default)]
struct Stats {
    underruns: AtomicU64,
    callbacks: AtomicU64,
    callback_frames: AtomicU64,
    latency_us: AtomicU64,
}

fn print(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    println!("[js] {}", args.get(0).to_rust_string_lossy(scope));
}

fn read(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let url = args.get(0).to_rust_string_lossy(scope);
    let path = url.split(['?', '#']).next().unwrap_or("").trim_start_matches('/');
    if let Ok(bytes) = std::fs::read(DIST.get().unwrap().join(path)) {
        let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
        rv.set(v8::ArrayBuffer::with_backing_store(scope, &store).into());
    } else {
        println!("[read] missing {url}");
    }
}

fn run<'s>(scope: &mut v8::PinScope<'s, '_>, source: &str, name: &str) -> v8::Local<'s, v8::Value> {
    v8::tc_scope!(let try_catch, scope);
    let code = v8::String::new(try_catch, source).unwrap();
    let origin_name = v8::String::new(try_catch, name).unwrap();
    let origin = v8::ScriptOrigin::new(try_catch, origin_name.into(), 0, 0, false, 0, None, false, false, false, None);
    let result = v8::Script::compile(try_catch, code, Some(&origin)).and_then(|script| script.run(try_catch));
    match result {
        Some(value) => value,
        None => {
            let message = try_catch.exception().map(|exception| exception.to_rust_string_lossy(try_catch)).unwrap_or_default();
            panic!("{name}: {message}");
        }
    }
}

fn engine_thread(mut producer: rtrb::Producer<f32>, sample_rate: u32, stats: Arc<Stats>) {
    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform.clone());
    v8::V8::initialize();
    let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
    v8::scope!(let handle_scope, isolate);
    let global = v8::ObjectTemplate::new(handle_scope);
    global.set(v8::String::new(handle_scope, "__print").unwrap().into(), v8::FunctionTemplate::new(handle_scope, print).into());
    global.set(v8::String::new(handle_scope, "__read").unwrap().into(), v8::FunctionTemplate::new(handle_scope, read).into());
    let context = v8::Context::new(handle_scope, v8::ContextOptions { global_template: Some(global), ..Default::default() });
    let scope = &mut v8::ContextScope::new(handle_scope, context);
    run(scope, PRELUDE, "prelude");
    let stress: u32 = std::env::var("STRESS").ok().and_then(|value| value.parse().ok()).unwrap_or(0);
    run(scope, &format!("globalThis.__stress = {stress}"), "stress");
    run(scope, HOST, "host.js");
    let started = Instant::now();
    run(scope, &format!("globalThis.__init = 0; spike.init({sample_rate}).then(() => __init = 1, error => {{__init = 2; console.error(error?.stack ?? error)}})"), "init");
    loop {
        while v8::Platform::pump_message_loop(&platform, scope, false) {}
        scope.perform_microtask_checkpoint();
        match run(scope, "__init", "poll").int32_value(scope).unwrap_or(0) {
            0 => std::thread::sleep(Duration::from_millis(1)),
            1 => break,
            _ => panic!("init failed"),
        }
    }
    println!("[engine] initialised in {:?}", started.elapsed());
    let out = v8::Local::<v8::Float32Array>::try_from(run(scope, "globalThis.__out = new Float32Array(256); __out", "out")).unwrap();
    let store = out.buffer(scope).unwrap().get_backing_store();
    let out_ptr = store.data().unwrap().as_ptr() as *const f32;
    let render = v8::Local::<v8::Function>::try_from(run(scope, "spike.render", "render")).unwrap();
    let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
    let args = [out.into()];
    let _priority = match std::env::var("NO_RT") {
        Ok(_) => None,
        Err(_) => match audio_thread_priority::promote_current_thread_to_real_time(QUANTUM as u32, sample_rate) {
            Ok(handle) => {
                println!("[engine] real-time priority on");
                Some(handle)
            }
            Err(error) => {
                println!("[engine] real-time priority failed: {error:?}");
                None
            }
        },
    };
    let (mut count, mut total, mut worst) = (0u64, Duration::ZERO, Duration::ZERO);
    let mut report = Instant::now();
    loop {
        while producer.slots() >= QUANTUM * 2 {
            let begin = Instant::now();
            render.call(scope, receiver, &args).expect("render threw");
            let elapsed = begin.elapsed();
            let samples = unsafe { std::slice::from_raw_parts(out_ptr, QUANTUM * 2) };
            let chunk = producer.write_chunk_uninit(QUANTUM * 2).unwrap();
            chunk.fill_from_iter(samples.iter().copied());
            count += 1;
            total += elapsed;
            worst = worst.max(elapsed);
        }
        if report.elapsed() >= Duration::from_secs(1) {
            let budget = Duration::from_secs_f64(QUANTUM as f64 / sample_rate as f64);
            let callbacks = stats.callbacks.swap(0, Ordering::Relaxed).max(1);
            println!("[engine] quanta {count} avg {:?} worst {:?} (budget {budget:?}) | ring {} frames | callback {} frames, output latency {:.2} ms | underruns this second {}",
                total / count.max(1) as u32, worst, (producer.buffer().capacity() - producer.slots()) / 2,
                stats.callback_frames.load(Ordering::Relaxed) / callbacks.min(1).max(1),
                stats.latency_us.load(Ordering::Relaxed) as f64 / 1000.0, stats.underruns.swap(0, Ordering::Relaxed));
            (count, total, worst) = (0, Duration::ZERO, Duration::ZERO);
            report = Instant::now();
        }
        std::thread::park_timeout(Duration::from_millis(1));
    }
}

fn main() {
    let dist = std::env::var("OPENDAW_DIST").map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../studio/dist-desktop")));
    DIST.set(dist).unwrap();
    let ring_frames: usize = std::env::var("RING").ok().and_then(|value| value.parse().ok()).unwrap_or(512);
    let buffer: u32 = std::env::var("BUFFER").ok().and_then(|value| value.parse().ok()).unwrap_or(128);
    let sample_rate = 48_000;
    let device = cpal::default_host().default_output_device().expect("no output device");
    println!("[audio] device {:?}, buffer {buffer} frames, ring {ring_frames} frames", device.description().map(|description| description.name().to_string()));
    let (producer, mut consumer) = rtrb::RingBuffer::<f32>::new(ring_frames * 2);
    let stats = Arc::new(Stats::default());
    let engine = {
        let stats = stats.clone();
        std::thread::Builder::new().name("engine".into()).spawn(move || engine_thread(producer, sample_rate, stats)).unwrap()
    };
    let waker = engine.thread().clone();
    let callback_stats = stats.clone();
    let config = cpal::StreamConfig { channels: 2, sample_rate, buffer_size: cpal::BufferSize::Fixed(buffer) };
    let stream = device.build_output_stream(config, move |data: &mut [f32], info: &cpal::OutputCallbackInfo| {
        let timestamp = info.timestamp();
        callback_stats.latency_us.store(timestamp.playback.duration_since(timestamp.callback).as_micros() as u64, Ordering::Relaxed);
        callback_stats.callbacks.fetch_add(1, Ordering::Relaxed);
        callback_stats.callback_frames.store(data.len() as u64 / 2, Ordering::Relaxed);
        let available = consumer.slots().min(data.len());
        if available < data.len() && callback_stats.callbacks.load(Ordering::Relaxed) > 0 {
            callback_stats.underruns.fetch_add(1, Ordering::Relaxed);
        }
        if let Ok(chunk) = consumer.read_chunk(available) {
            let (first, second) = chunk.as_slices();
            data[..first.len()].copy_from_slice(first);
            data[first.len()..first.len() + second.len()].copy_from_slice(second);
            chunk.commit_all();
        }
        data[available..].fill(0.0);
        waker.unpark();
    }, |error| eprintln!("[audio] {error}"), None).expect("output stream");
    stream.play().expect("play");
    engine.join().unwrap();
}

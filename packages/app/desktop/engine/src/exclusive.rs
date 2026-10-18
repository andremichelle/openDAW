// WASAPI exclusive mode (Windows): openDAW alone on the card, past the Windows mixer, so the output latency is about the
// buffer size instead of the shared mode's periods (90 ms reported on a Bitwig Connect). Other programs cannot play on
// that card meanwhile, so it is a choice in the studio's audio output, shared mode stays the default.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use wasapi::{calculate_period_100ns, AudioClient, Device, DeviceEnumerator, Direction, SampleType, StreamMode, WasapiError, WaveFormat};

use crate::{fill, stats, DEVICE_LATENCY_US, RING_LATENCY_US, RING_TARGET_FRAMES};

const BUFFER_SIZE_NOT_ALIGNED: u32 = 0x8889_0019;
const OPEN_TIMEOUT: Duration = Duration::from_secs(3);

pub struct Stream {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

// the sample formats tried, best first: the card decides what it takes in exclusive mode
#[derive(Clone, Copy)]
enum Sample {
    Float32,
    Int32,
    Int24,
    Int16,
}

impl Sample {
    fn format(self, rate: usize) -> WaveFormat {
        match self {
            Sample::Float32 => WaveFormat::new(32, 32, &SampleType::Float, rate, 2, None),
            Sample::Int32 => WaveFormat::new(32, 24, &SampleType::Int, rate, 2, None),
            Sample::Int24 => WaveFormat::new(24, 24, &SampleType::Int, rate, 2, None),
            Sample::Int16 => WaveFormat::new(16, 16, &SampleType::Int, rate, 2, None),
        }
    }

    fn write(self, samples: &[f32], bytes: &mut Vec<u8>) {
        bytes.clear();
        for sample in samples.iter().map(|sample| sample.clamp(-1.0, 1.0)) {
            match self {
                Sample::Float32 => bytes.extend_from_slice(&sample.to_le_bytes()),
                Sample::Int32 => bytes.extend_from_slice(&((sample as f64 * i32::MAX as f64) as i32).to_le_bytes()),
                Sample::Int24 => bytes.extend_from_slice(&((sample as f64 * 8_388_607.0) as i32).to_le_bytes()[..3]),
                Sample::Int16 => bytes.extend_from_slice(&((sample * i16::MAX as f32) as i16).to_le_bytes()),
            }
        }
    }
}

const SAMPLES: [Sample; 4] = [Sample::Float32, Sample::Int32, Sample::Int24, Sample::Int16];

fn device(requested: &str) -> Result<Device, WasapiError> {
    let enumerator = DeviceEnumerator::new()?;
    if !requested.is_empty() {
        let collection = enumerator.get_device_collection(&Direction::Render)?;
        for device in &collection {
            let device = device?;
            if device.get_friendlyname().is_ok_and(|name| name == requested) { return Ok(device); }
        }
    }
    enumerator.get_default_device(&Direction::Render)
}

struct Opened {
    client: AudioClient,
    format: WaveFormat,
    sample: Sample,
    rate: u32,
    name: String,
    // the shortest period the card allows, in frames: the floor of the latency
    minimum: u64,
}

// 48 kHz first like the shared output, then the card's own rate
fn open(requested: &str, buffer: u32, preferred_rate: u32) -> Result<Opened, String> {
    let device = device(requested).map_err(|error| error.to_string())?;
    let name = device.get_friendlyname().unwrap_or_default();
    let probe = device.get_iaudioclient().map_err(|error| error.to_string())?;
    let own_rate = probe.get_mixformat().map(|format| format.get_samplespersec()).unwrap_or(preferred_rate);
    let rates = if own_rate == preferred_rate { vec![preferred_rate] } else { vec![preferred_rate, own_rate] };
    let (format, sample, rate) = rates.iter().flat_map(|rate| SAMPLES.iter().map(move |sample| (*sample, *rate)))
        .find_map(|(sample, rate)| probe.is_supported_exclusive_with_quirks(&sample.format(rate as usize)).ok().map(|format| (format, sample, rate)))
        .ok_or_else(|| format!("{name} takes no stereo format in exclusive mode"))?;
    let mut client = device.get_iaudioclient().map_err(|error| error.to_string())?;
    let minimum = client.get_device_period().map(|(_, minimum)| minimum.max(0) as u64 * rate as u64 / 10_000_000).unwrap_or(0);
    let desired = calculate_period_100ns(buffer as i64, rate as i64);
    let period = client.calculate_aligned_period_near(desired, Some(128), &format).map_err(|error| error.to_string())?;
    let mode = StreamMode::EventsExclusive { period_hns: period };
    if let Err(error) = client.initialize_client(&format, &Direction::Render, &mode) {
        let unaligned = matches!(&error, WasapiError::Windows(error) if error.code().0 as u32 == BUFFER_SIZE_NOT_ALIGNED);
        if !unaligned { return Err(format!("{name}: {error}")); }
        // the documented recovery: the next aligned size, a new client
        let frames = client.get_buffer_size().map_err(|error| error.to_string())?;
        client = device.get_iaudioclient().map_err(|error| error.to_string())?;
        let mode = StreamMode::EventsExclusive { period_hns: calculate_period_100ns(frames as i64, rate as i64) };
        client.initialize_client(&format, &Direction::Render, &mode).map_err(|error| format!("{name}: {error}"))?;
    }
    Ok(Opened { client, format, sample, rate, name, minimum })
}

// opens the stream on its own thread (WASAPI wants the thread that renders), answers its rate and the card's name
pub fn start(requested: &str, buffer: u32, preferred_rate: u32, consumer: Arc<Mutex<rtrb::Consumer<f32>>>,
             waker: std::thread::Thread) -> Result<(Stream, u32, String), String> {
    let stop = Arc::new(AtomicBool::new(false));
    let (answer, answered) = channel::<Result<(u32, String), String>>();
    let (requested, running) = (requested.to_string(), stop.clone());
    let thread = std::thread::Builder::new().name("exclusive output".into()).spawn(move || {
        let _ = wasapi::initialize_mta();
        let opened = match open(&requested, buffer, preferred_rate) {
            Ok(opened) => opened,
            Err(error) => {
                let _ = answer.send(Err(error));
                return;
            }
        };
        if let Err(error) = render(&opened, &consumer, &waker, &running, &answer) {
            eprintln!("[engine] exclusive output {}: {error}", opened.name);
        }
    }).map_err(|error| error.to_string())?;
    match answered.recv_timeout(OPEN_TIMEOUT) {
        Ok(Ok((rate, name))) => Ok((Stream { stop, thread: Some(thread) }, rate, name)),
        Ok(Err(error)) => Err(error),
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            Err("the card did not answer".into())
        }
    }
}

fn render(opened: &Opened, consumer: &Mutex<rtrb::Consumer<f32>>, waker: &std::thread::Thread, stop: &AtomicBool,
          answer: &std::sync::mpsc::Sender<Result<(u32, String), String>>) -> Result<(), WasapiError> {
    let Opened { client, format, sample, rate, name, minimum } = opened;
    let event = client.set_get_eventhandle()?;
    let renderer = client.get_audiorenderclient()?;
    let period = client.get_buffer_size()? as usize;
    let mut samples = vec![0f32; period * 2];
    let mut bytes = Vec::with_capacity(period * format.get_blockalign() as usize);
    // a first period of silence before the start, as the documentation asks
    sample.write(&samples, &mut bytes);
    renderer.write_to_device(period, &bytes, None)?;
    let target = crate::exclusive_reserve(period);
    RING_TARGET_FRAMES.store(target, Ordering::Relaxed);
    RING_LATENCY_US.store(target as u64 * 1_000_000 / *rate as u64, Ordering::Relaxed);
    DEVICE_LATENCY_US.store(period as u64 * 1_000_000 / *rate as u64, Ordering::Relaxed);
    stats::CALLBACK_FRAMES.store(period as u64, Ordering::Relaxed);
    pro_audio_priority();
    client.start_stream()?;
    println!("[engine] exclusive output {name}, {rate} Hz, period {period} frames (the card allows {minimum})");
    let _ = answer.send(Ok((*rate, name.clone())));
    while !stop.load(Ordering::SeqCst) {
        if event.wait_for_event(1000).is_err() { continue; }
        let frames = client.get_available_space_in_frames()? as usize;
        if frames == 0 { continue; }
        samples.resize(frames * 2, 0.0);
        fill(&mut samples, consumer, waker);
        sample.write(&samples, &mut bytes);
        renderer.write_to_device(frames, &bytes, None)?;
    }
    client.stop_stream()?;
    Ok(())
}

// the thread the card waits on runs as "Pro Audio" (MMCSS), like other low-latency hosts
fn pro_audio_priority() {
    use windows_sys::Win32::System::Threading::AvSetMmThreadCharacteristicsW;
    let task: Vec<u16> = "Pro Audio\0".encode_utf16().collect();
    let mut index = 0u32;
    unsafe { AvSetMmThreadCharacteristicsW(task.as_ptr(), &mut index); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_convert_to_the_cards_format() {
        let mut bytes = Vec::new();
        Sample::Int16.write(&[1.0, -1.0, 0.0, 2.0], &mut bytes);
        assert_eq!(bytes, [0xFF, 0x7F, 0x01, 0x80, 0, 0, 0xFF, 0x7F]);
        Sample::Int24.write(&[1.0, -1.0], &mut bytes);
        assert_eq!(bytes, [0xFF, 0xFF, 0x7F, 0x01, 0x00, 0x80]);
        Sample::Float32.write(&[0.5], &mut bytes);
        assert_eq!(bytes, 0.5f32.to_le_bytes());
    }
}

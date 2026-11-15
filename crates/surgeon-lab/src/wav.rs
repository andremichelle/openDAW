use std::fs;
use std::path::Path;

const PEAK_LIMIT: f32 = 0.95;

/// Writes float 32, one slice per channel, levelled to `rms` over all channels so A/B files are equally loud.
pub fn write(path: &Path, sample_rate: f64, channels: &[&[f32]], rms: f32) -> Result<(), String> {
    let frames = channels.iter().map(|channel| channel.len()).min().unwrap_or(0);
    let loudest = channels.iter().flat_map(|channel| channel.iter()).fold(0.0f32, |max, sample| max.max(sample.abs()));
    let count = channels.iter().map(|channel| channel.len()).sum::<usize>().max(1);
    let power = channels.iter().flat_map(|channel| channel.iter()).map(|sample| (sample * sample) as f64).sum::<f64>();
    let measured = (power / count as f64).sqrt() as f32;
    let gain = if measured > 0.0 {(rms / measured).min(PEAK_LIMIT / loudest)} else {1.0};
    let block = (channels.len() * 4) as u16;
    let size = frames as u32 * block as u32;
    let mut bytes: Vec<u8> = Vec::with_capacity(44 + size as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + size).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&3u16.to_le_bytes());
    bytes.extend_from_slice(&(channels.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&(sample_rate as u32).to_le_bytes());
    bytes.extend_from_slice(&((sample_rate as u32) * block as u32).to_le_bytes());
    bytes.extend_from_slice(&block.to_le_bytes());
    bytes.extend_from_slice(&32u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&size.to_le_bytes());
    for frame in 0..frames {
        channels.iter().for_each(|channel| bytes.extend_from_slice(&(channel[frame] * gain).to_le_bytes()));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    fs::write(path, bytes).map_err(|error| format!("{}: {error}", path.display()))
}

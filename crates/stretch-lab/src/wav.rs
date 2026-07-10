//! Homebrew RIFF WAV codec: reads PCM 16/24/32-bit and IEEE float 32 (plus WAVE_FORMAT_EXTENSIBLE
//! wrappers), writes 32-bit float. No external crates — the fixtures and rendered outputs are the
//! only consumers.

use std::fs;
use std::io::Write as IoWrite;
use std::path::Path;

pub struct WavData {
    pub sample_rate: f32,
    pub channels: Vec<Vec<f32>>
}

impl WavData {
    pub fn num_frames(&self) -> usize {
        self.channels.first().map(|channel| channel.len()).unwrap_or(0)
    }

    /// Left/right planes; mono duplicates the single channel.
    pub fn stereo(&self) -> (Vec<f32>, Vec<f32>) {
        match self.channels.len() {
            0 => (Vec::new(), Vec::new()),
            1 => (self.channels[0].clone(), self.channels[0].clone()),
            _ => (self.channels[0].clone(), self.channels[1].clone())
        }
    }
}

pub fn read(path: &Path) -> Result<WavData, String> {
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(format!("{}: not a RIFF/WAVE file", path.display()));
    }
    let mut offset = 12usize;
    let mut format_code = 0u16;
    let mut num_channels = 0usize;
    let mut sample_rate = 0u32;
    let mut bits = 0u16;
    let mut data: Option<&[u8]> = None;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes([bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]]) as usize;
        let body_start = offset + 8;
        let body_end = (body_start + size).min(bytes.len());
        let body = &bytes[body_start..body_end];
        match id {
            b"fmt " => {
                if body.len() < 16 {
                    return Err(format!("{}: fmt chunk too small", path.display()));
                }
                format_code = u16::from_le_bytes([body[0], body[1]]);
                num_channels = u16::from_le_bytes([body[2], body[3]]) as usize;
                sample_rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
                bits = u16::from_le_bytes([body[14], body[15]]);
                if format_code == 0xFFFE && body.len() >= 26 {
                    format_code = u16::from_le_bytes([body[24], body[25]]);
                }
            }
            b"data" => {
                data = Some(body);
            }
            _ => {}
        }
        offset = body_start + size + (size & 1);
    }
    let data = data.ok_or_else(|| format!("{}: no data chunk", path.display()))?;
    if num_channels == 0 || sample_rate == 0 {
        return Err(format!("{}: missing/invalid fmt chunk", path.display()));
    }
    let bytes_per_sample = (bits as usize) / 8;
    if bytes_per_sample == 0 {
        return Err(format!("{}: invalid bit depth {bits}", path.display()));
    }
    let num_frames = data.len() / (bytes_per_sample * num_channels);
    let mut channels = vec![Vec::with_capacity(num_frames); num_channels];
    let decode = |chunk: &[u8]| -> Result<f32, String> {
        match (format_code, bits) {
            (1, 16) => Ok(i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0),
            (1, 24) => {
                let value = ((chunk[2] as i32) << 24 | (chunk[1] as i32) << 16 | (chunk[0] as i32) << 8) >> 8;
                Ok(value as f32 / 8388608.0)
            }
            (1, 32) => Ok(i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as f32 / 2147483648.0),
            (3, 32) => Ok(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])),
            _ => Err(format!("unsupported wav format code {format_code} / {bits} bit"))
        }
    };
    for frame in 0..num_frames {
        for (channel_index, channel) in channels.iter_mut().enumerate() {
            let start = (frame * num_channels + channel_index) * bytes_per_sample;
            channel.push(decode(&data[start..start + bytes_per_sample])?);
        }
    }
    Ok(WavData {sample_rate: sample_rate as f32, channels})
}

pub fn write_32f(path: &Path, sample_rate: f32, left: &[f32], right: &[f32]) -> Result<(), String> {
    let num_frames = left.len().min(right.len());
    let data_size = (num_frames * 2 * 4) as u32;
    let mut bytes: Vec<u8> = Vec::with_capacity(44 + data_size as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&3u16.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&(sample_rate as u32).to_le_bytes());
    bytes.extend_from_slice(&((sample_rate as u32) * 2 * 4).to_le_bytes());
    bytes.extend_from_slice(&8u16.to_le_bytes());
    bytes.extend_from_slice(&32u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_size.to_le_bytes());
    for frame in 0..num_frames {
        bytes.extend_from_slice(&left[frame].to_le_bytes());
        bytes.extend_from_slice(&right[frame].to_le_bytes());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    let mut file = fs::File::create(path).map_err(|error| format!("{}: {error}", path.display()))?;
    file.write_all(&bytes).map_err(|error| format!("{}: {error}", path.display()))
}

use std::fs;
use std::path::Path;

pub struct Mono {
    pub sample_rate: f64,
    pub samples: Vec<f64>
}

/// Reads PCM 16/24 bit and float 32 RIFF files, mixes all channels to mono.
pub fn read_mono(path: &Path) -> Result<Mono, String> {
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(format!("{}: not a RIFF/WAVE file", path.display()));
    }
    let (mut offset, mut format, mut channels, mut sample_rate, mut bits) = (12usize, 0u16, 0usize, 0u32, 0u16);
    let mut data: Option<&[u8]> = None;
    while offset + 8 <= bytes.len() {
        let size = u32::from_le_bytes([bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]]) as usize;
        let body = &bytes[offset + 8..(offset + 8 + size).min(bytes.len())];
        match &bytes[offset..offset + 4] {
            b"fmt " if body.len() >= 16 => {
                format = u16::from_le_bytes([body[0], body[1]]);
                channels = u16::from_le_bytes([body[2], body[3]]) as usize;
                sample_rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
                bits = u16::from_le_bytes([body[14], body[15]]);
                if format == 0xFFFE && body.len() >= 26 {format = u16::from_le_bytes([body[24], body[25]]);}
            }
            b"data" => data = Some(body),
            _ => {}
        }
        offset += 8 + size + (size & 1);
    }
    let data = data.ok_or_else(|| format!("{}: no data chunk", path.display()))?;
    let width = bits as usize / 8;
    if channels == 0 || sample_rate == 0 || width == 0 {
        return Err(format!("{}: invalid fmt chunk", path.display()));
    }
    let decode = |chunk: &[u8]| -> Result<f64, String> {
        match (format, bits) {
            (1, 16) => Ok(i16::from_le_bytes([chunk[0], chunk[1]]) as f64 / 32768.0),
            (1, 24) => Ok((((chunk[2] as i32) << 24 | (chunk[1] as i32) << 16 | (chunk[0] as i32) << 8) >> 8) as f64 / 8388608.0),
            (3, 32) => Ok(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as f64),
            _ => Err(format!("{}: unsupported format {format} / {bits} bit", path.display()))
        }
    };
    let frames = data.len() / (width * channels);
    let mut samples = Vec::with_capacity(frames);
    for frame in 0..frames {
        let mut sum = 0.0;
        for channel in 0..channels {
            let start = (frame * channels + channel) * width;
            sum += decode(&data[start..start + width])?;
        }
        samples.push(sum / channels as f64);
    }
    Ok(Mono {sample_rate: sample_rate as f64, samples})
}

/// Writes mono float 32, for A/B listening files.
pub fn write_mono(path: &Path, sample_rate: f64, samples: &[f64]) -> Result<(), String> {
    let size = (samples.len() * 4) as u32;
    let mut bytes: Vec<u8> = Vec::with_capacity(44 + size as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + size).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&3u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&(sample_rate as u32).to_le_bytes());
    bytes.extend_from_slice(&((sample_rate as u32) * 4).to_le_bytes());
    bytes.extend_from_slice(&4u16.to_le_bytes());
    bytes.extend_from_slice(&32u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&size.to_le_bytes());
    samples.iter().for_each(|sample| bytes.extend_from_slice(&(*sample as f32).to_le_bytes()));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    fs::write(path, bytes).map_err(|error| format!("{}: {error}", path.display()))
}

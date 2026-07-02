//! Zero-copy reader over the SIMPLIFIED soundfont BLOB the host delivers (built on the main thread from the
//! parsed `.sf2`; see `packages/app/wasm/src/soundfont-simplify.ts`). The device reads it IN PLACE by fixed
//! byte offset — no allocation, no parsing. All scalars are little-endian.
//!
//! Layout (WASM CONTRACT — mirrored exactly by the TS builder):
//! ```text
//! Header (32 bytes):  magic u32 | version u32 | sample_count u32 | region_count u32 |
//!                     preset_count u32 | samples_off u32 | regions_off u32 | presets_off u32
//! SampleDesc (24):    pcm_off u32 | frame_count u32 | sample_rate f32 | loop_start u32 | loop_end u32 | root u32
//! RegionDesc (40):    key_lo u8 | key_hi u8 | vel_lo u8 | vel_hi u8 | sample_index u32 | root_key u32 |
//!                     loop_mode u32 | pan f32 | attack f32 | decay f32 | sustain f32 | release f32 | _pad u32
//! PresetDesc (8):     region_start u32 | region_count u32
//! PCM: concatenated normalized f32, each SampleDesc.pcm_off points to its plane (mono).
//! ```

pub const MAGIC: u32 = 0x4F53_4632; // "OSF2"
pub const SAMPLE_STRIDE: usize = 24;
pub const REGION_STRIDE: usize = 40;
pub const PRESET_STRIDE: usize = 8;

#[inline]
fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]])
}

#[inline]
fn read_f32(bytes: &[u8], offset: usize) -> f32 {
    f32::from_le_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]])
}

/// One flattened region (a preset-zone × instrument-zone product), with every SF2 generator already resolved
/// on the TS side (instrument-overrides-preset, timecent→seconds, sustain 1−x/1000).
#[derive(Clone, Copy)]
pub struct Region {
    pub key_lo: u8,
    pub key_hi: u8,
    pub vel_lo: u8,
    pub vel_hi: u8,
    pub sample_index: u32,
    pub root_key: u32,
    pub loop_mode: u32,
    pub pan: f32,
    pub attack: f32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32
}

impl Region {
    /// Whether a MIDI `pitch` and `velocity_byte` (0..127) fall inside this region's key + velocity ranges.
    #[inline]
    pub fn matches(&self, pitch: u32, velocity_byte: u32) -> bool {
        pitch >= self.key_lo as u32 && pitch <= self.key_hi as u32
            && velocity_byte >= self.vel_lo as u32 && velocity_byte <= self.vel_hi as u32
    }
}

/// One sample: its PCM plane (already normalized f32) + rate + loop points (loop points relative to start).
#[derive(Clone, Copy)]
pub struct Sample {
    pub pcm_ptr: u32, // absolute address of the f32 plane in shared memory (blob base + pcm_off)
    pub frame_count: u32,
    pub sample_rate: f32,
    pub loop_start: u32,
    pub loop_end: u32
}

impl Sample {
    /// The PCM plane as a safe slice. Borrows the resident soundfont blob, valid while it stays resident.
    #[inline]
    pub fn plane(&self) -> &[f32] {
        unsafe { core::slice::from_raw_parts(self.pcm_ptr as *const f32, self.frame_count as usize) }
    }
}

/// A zero-copy view over the blob: `base` is the blob's absolute start address (so PCM offsets resolve to
/// absolute pointers), `bytes` the blob slice for the tables.
pub struct Soundfont<'a> {
    base: u32,
    bytes: &'a [u8]
}

impl<'a> Soundfont<'a> {
    /// Build a view over `bytes` whose absolute start address is `base`. Returns `None` if the blob is too small
    /// or the magic is wrong (a not-yet-written / corrupt allocation).
    #[inline]
    pub fn new(base: u32, bytes: &'a [u8]) -> Option<Self> {
        if bytes.len() < 32 || read_u32(bytes, 0) != MAGIC {
            return None;
        }
        Some(Self {base, bytes})
    }

    #[inline]
    pub fn preset_count(&self) -> u32 {
        read_u32(self.bytes, 16)
    }

    #[inline]
    fn samples_off(&self) -> usize {
        read_u32(self.bytes, 20) as usize
    }

    #[inline]
    fn regions_off(&self) -> usize {
        read_u32(self.bytes, 24) as usize
    }

    #[inline]
    fn presets_off(&self) -> usize {
        read_u32(self.bytes, 28) as usize
    }

    /// The `[region_start, region_count)` range of the preset at `index` (clamped to preset 0 when out of range,
    /// mirroring the TS `presets[presetIndex] ?? presets[0]`). `None` when there are no presets.
    #[inline]
    pub fn preset_regions(&self, index: u32) -> Option<(u32, u32)> {
        let count = self.preset_count();
        if count == 0 {
            return None;
        }
        let index = if index < count {index} else {0};
        let base = self.presets_off() + index as usize * PRESET_STRIDE;
        Some((read_u32(self.bytes, base), read_u32(self.bytes, base + 4)))
    }

    /// Read the region at absolute region-table index `region_index`.
    #[inline]
    pub fn region(&self, region_index: u32) -> Region {
        let base = self.regions_off() + region_index as usize * REGION_STRIDE;
        Region {
            key_lo: self.bytes[base],
            key_hi: self.bytes[base + 1],
            vel_lo: self.bytes[base + 2],
            vel_hi: self.bytes[base + 3],
            sample_index: read_u32(self.bytes, base + 4),
            root_key: read_u32(self.bytes, base + 8),
            loop_mode: read_u32(self.bytes, base + 12),
            pan: read_f32(self.bytes, base + 16),
            attack: read_f32(self.bytes, base + 20),
            decay: read_f32(self.bytes, base + 24),
            sustain: read_f32(self.bytes, base + 28),
            release: read_f32(self.bytes, base + 32)
        }
    }

    /// Read the sample at index `sample_index`, resolving its PCM offset to an absolute pointer.
    #[inline]
    pub fn sample(&self, sample_index: u32) -> Sample {
        let base = self.samples_off() + sample_index as usize * SAMPLE_STRIDE;
        Sample {
            pcm_ptr: self.base + read_u32(self.bytes, base),
            frame_count: read_u32(self.bytes, base + 4),
            sample_rate: read_f32(self.bytes, base + 8),
            loop_start: read_u32(self.bytes, base + 12),
            loop_end: read_u32(self.bytes, base + 16)
        }
    }
}

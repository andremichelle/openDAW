//! Shared by the Wclap effect and instrument devices.

#![no_std]

use abi::{Block, FieldValue};

pub const RENDER_QUANTUM: usize = 128;
const URL_FIELD: [u16; 1] = [10];
const CLAP_ID_FIELD: [u16; 1] = [11];
const STATE_FIELD: [u16; 1] = [12];
const URL_CAPACITY: usize = 1024;
const CLAP_ID_CAPACITY: usize = 256;

pub struct WclapLink {
    pub bridge: u32,
    url_field_id: u32,
    clap_id_field_id: u32,
    state_field_id: u32,
    url: [u8; URL_CAPACITY],
    url_len: usize,
    clap_id: [u8; CLAP_ID_CAPACITY],
    clap_id_len: usize,
    scratch_in: [[f32; RENDER_QUANTUM]; 2],
    scratch_out: [[f32; RENDER_QUANTUM]; 2]
}

impl WclapLink {
    pub fn init(&mut self) {
        self.bridge = abi::wclap_create(&abi::self_uuid());
        self.url_field_id = abi::observe_field(&URL_FIELD);
        self.clap_id_field_id = abi::observe_field(&CLAP_ID_FIELD);
        self.state_field_id = abi::observe_field(&STATE_FIELD);
    }

    pub fn url(&self) -> &[u8] {&self.url[..self.url_len]}
    pub fn clap_id(&self) -> &[u8] {&self.clap_id[..self.clap_id_len]}

    /// The bridge reloads only when url or clap id changed.
    pub fn apply_field(&mut self, id: u32, value: FieldValue) {
        let FieldValue::String(text) = value else {return};
        if id == self.state_field_id {
            abi::wclap_state(self.bridge, text);
            return;
        }
        if id == self.url_field_id {
            self.url_len = copy_into(&mut self.url, text);
        } else if id == self.clap_id_field_id {
            self.clap_id_len = copy_into(&mut self.clap_id, text);
        } else {
            return;
        }
        let url = core::str::from_utf8(self.url()).unwrap_or("");
        let clap_id = core::str::from_utf8(self.clap_id()).unwrap_or("");
        abi::wclap_load(self.bridge, url, clap_id);
    }

    pub fn reset(&self) {abi::wclap_reset(self.bridge)}
    pub fn release(&self) {abi::wclap_release(self.bridge)}

    /// One chunk `[s0, s1)` of the effect: input through the plugin, or a passthrough while it is not ready.
    pub fn process_effect(&mut self, in_left: &[f32], in_right: &[f32],
                          out_left: &mut [f32], out_right: &mut [f32], s0: usize, s1: usize, block: &Block) {
        let frames = s1 - s0;
        self.scratch_in[0][..frames].copy_from_slice(&in_left[s0..s1]);
        self.scratch_in[1][..frames].copy_from_slice(&in_right[s0..s1]);
        if self.run(frames, block) {
            out_left[s0..s1].copy_from_slice(&self.scratch_out[0][..frames]);
            out_right[s0..s1].copy_from_slice(&self.scratch_out[1][..frames]);
        } else {
            out_left[s0..s1].copy_from_slice(&in_left[s0..s1]);
            out_right[s0..s1].copy_from_slice(&in_right[s0..s1]);
        }
    }

    /// One sub-chunk of the instrument: the side-chain (or silence) in, the plugin's output ADDED to `out`.
    pub fn process_instrument(&mut self, input: Option<[&[f32]; 2]>, out_left: &mut [f32], out_right: &mut [f32], block: &Block) {
        let frames = out_left.len().min(RENDER_QUANTUM);
        match input {
            Some([in_left, in_right]) if in_left.len() >= frames && in_right.len() >= frames => {
                self.scratch_in[0][..frames].copy_from_slice(&in_left[..frames]);
                self.scratch_in[1][..frames].copy_from_slice(&in_right[..frames]);
            }
            _ => {
                self.scratch_in[0][..frames].fill(0.0);
                self.scratch_in[1][..frames].fill(0.0);
            }
        }
        if !self.run(frames, block) {return}
        for index in 0..frames {
            out_left[index] += self.scratch_out[0][index];
            out_right[index] += self.scratch_out[1][index];
        }
    }

    fn run(&mut self, frames: usize, block: &Block) -> bool {
        let [scratch_out_left, scratch_out_right] = &mut self.scratch_out;
        abi::wclap_process(self.bridge, [&self.scratch_in[0], &self.scratch_in[1]],
                           [scratch_out_left, scratch_out_right], frames, block)
    }
}

fn copy_into(target: &mut [u8], text: &str) -> usize {
    let bytes = text.as_bytes();
    let len = bytes.len().min(target.len());
    target[..len].copy_from_slice(&bytes[..len]);
    len
}

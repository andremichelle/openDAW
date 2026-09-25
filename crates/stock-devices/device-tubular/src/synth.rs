//! The Dexed host layer (`PluginProcessor.cpp` keydown / keyup / processBlock): 16 voices with Dexed's
//! scored voice choice, mono mode with state transfer, the shared LFO, patch refresh on edits, and the
//! N-sample render frame summed to float with the plugin's clip quirk.

use crate::fm::{Engine, FmCore};
use crate::fx::PluginFx;
use crate::lfo::Lfo;
use crate::note::{Controllers, Dx7Note, NoteRates};
use crate::porta::Porta;
use crate::tables::Tables;
use crate::{env, patch, pitchenv, N};

pub const MAX_ACTIVE_NOTES: usize = 16;
const TRANSPOSE_CENTRE: i32 = 24;

#[derive(Clone, Copy, Default)]
struct ProcessorVoice {
    midi_note: i32,
    velocity: i32,
    keydown: bool,
    sustained: bool,
    live: bool,
    keydown_seq: i32,
    note: Dx7Note
}

pub struct Synth {
    voices: [ProcessorVoice; MAX_ACTIVE_NOTES],
    current_note: usize,
    next_keydown_seq: i32,
    last_active_voice: usize,
    lfo: Lfo,
    pub controllers: Controllers,
    core: FmCore,
    pub data: [u8; 161],
    mono_mode: bool,
    sustain: bool,
    refresh_voice: bool,
    pub fx: PluginFx,
    pub engine: Engine,
    tables: Tables,
    porta: Porta,
    rates: NoteRates
}

impl Synth {
    /// Build every table for `sample_rate` and load the init voice (the state block arrives zeroed).
    pub fn init(&mut self, sample_rate: f64) {
        self.tables.init(sample_rate);
        self.lfo.init(sample_rate);
        self.porta.init(sample_rate);
        self.fx.init(sample_rate as i32);
        self.rates = NoteRates {sr_multiplier: env::sr_multiplier(sample_rate), pitchenv_unit: pitchenv::unit(sample_rate)};
        self.controllers = Controllers::default();
        self.core = FmCore::default();
        self.engine = Engine::MarkI;
        for voice in self.voices.iter_mut() {
            *voice = ProcessorVoice {midi_note: -1, keydown_seq: -1, ..ProcessorVoice::default()};
        }
        self.current_note = 0;
        self.next_keydown_seq = 0;
        self.last_active_voice = 0;
        self.sustain = false;
        self.mono_mode = false;
        self.data = [0; 161];
        self.data[..155].copy_from_slice(&patch::INIT_VOICE);
        self.lfo.reset(&self.data[137..143]);
        self.refresh_voice = false;
    }

    pub fn load_patch(&mut self, voice: &[u8; 155]) {
        self.data[..155].copy_from_slice(voice);
        self.program_change();
    }

    /// A program change (`updateProgramFromSysex`): every note off, oscillators re-synced, the LFO restarted.
    pub fn program_change(&mut self) {
        self.panic();
        self.refresh_voice = true;
    }

    pub fn set_byte(&mut self, offset: usize, value: u8) {
        if self.data[offset] != value {
            self.data[offset] = value;
            self.refresh_voice = true;
        }
    }

    pub fn mono_mode(&self) -> bool {
        self.mono_mode
    }

    pub fn set_mono_mode(&mut self, mode: bool) {
        self.panic();
        self.mono_mode = mode;
    }

    fn transposed(&self, pitch: u8) -> u8 {
        pitch.wrapping_add((self.data[144] as i32 - TRANSPOSE_CENTRE) as u8)
    }

    fn choose_note(&self, pitch: i32) -> usize {
        let mut best_note = self.current_note;
        let mut best_score = -1;
        let mut note = self.current_note;
        for _ in 0..MAX_ACTIVE_NOTES {
            let mut score = 0;
            if !self.voices[note].note.is_playing() {
                score += 4;
            }
            if !self.voices[note].keydown {
                score += 2;
            }
            if self.voices[note].midi_note == pitch {
                score += 1;
            }
            if score > best_score || (score == best_score && self.voices[note].keydown_seq < self.voices[best_note].keydown_seq) {
                best_note = note;
                best_score = score;
            }
            note = (note + 1) % MAX_ACTIVE_NOTES;
        }
        best_note
    }

    /// Push pending patch edits into the sounding voices and the LFO. Dexed does this at the top of every
    /// block, ahead of that block's MIDI, so it runs before any key event and before each frame.
    fn flush_refresh(&mut self) {
        if !self.refresh_voice {
            return;
        }
        for voice in self.voices.iter_mut() {
            if voice.live {
                voice.note.update(&self.data, voice.midi_note, voice.velocity);
            }
        }
        self.lfo.reset(&self.data[137..143]);
        self.refresh_voice = false;
    }

    pub fn keydown(&mut self, pitch: u8, velo: u8, note_offset: i32) {
        if velo == 0 {
            self.keyup(pitch);
            return;
        }
        self.flush_refresh();
        let pitch = self.transposed(pitch) as i32;
        if !self.voices.iter().any(|voice| voice.keydown) {
            self.lfo.keydown();
        }
        let note = self.choose_note(pitch);
        self.current_note = (note + 1) % MAX_ACTIVE_NOTES;
        let voice_steal = self.voices[note].note.is_playing();
        {
            let voice = &mut self.voices[note];
            voice.midi_note = pitch;
            voice.velocity = velo as i32;
            voice.sustained = self.sustain;
            voice.keydown = true;
            voice.keydown_seq = self.next_keydown_seq;
            voice.note.init(&self.data, pitch, velo as i32, note_offset, &self.rates);
            if self.data[136] != 0 && !voice_steal {
                voice.note.osc_sync();
            }
        }
        self.next_keydown_seq += 1;
        if self.voices[self.last_active_voice].midi_note != -1 && self.controllers.portamento_enable && self.controllers.portamento_cc > 0 {
            let source = self.voices[self.last_active_voice].note;
            self.voices[note].note.init_portamento(&source);
        }
        if self.mono_mode {
            for i in 0..MAX_ACTIVE_NOTES {
                if self.voices[i].live {
                    if !self.voices[i].keydown {
                        self.voices[i].live = false;
                        let source = self.voices[i].note;
                        self.voices[note].note.transfer_signal(&source);
                        break;
                    }
                    if self.voices[i].midi_note < pitch {
                        self.voices[i].live = false;
                        let source = self.voices[i].note;
                        self.voices[note].note.transfer_state(&source);
                        break;
                    }
                    return;
                }
            }
        } else if self.data[136] == 0 {
            for i in 0..MAX_ACTIVE_NOTES {
                if i != note && self.voices[i].note.is_playing() && self.voices[i].midi_note == pitch {
                    let source = self.voices[i].note;
                    self.voices[note].note.transfer_phase(&source);
                    break;
                }
            }
        }
        self.voices[note].live = true;
        self.last_active_voice = note;
    }

    pub fn keyup(&mut self, pitch: u8) {
        self.flush_refresh();
        let pitch = self.transposed(pitch) as i32;
        let Some(note) = (0..MAX_ACTIVE_NOTES).find(|&index| self.voices[index].midi_note == pitch && self.voices[index].keydown) else {
            return;
        };
        self.voices[note].keydown = false;
        if self.mono_mode {
            let mut high_note = -1;
            let mut target = 0;
            for i in 0..MAX_ACTIVE_NOTES {
                if self.voices[i].keydown && self.voices[i].midi_note > high_note {
                    target = i;
                    high_note = self.voices[i].midi_note;
                }
            }
            if high_note != -1 && self.voices[note].live {
                self.voices[note].live = false;
                self.voices[target].live = true;
                let source = self.voices[note].note;
                self.voices[target].note.transfer_state(&source);
            }
        }
        if self.sustain {
            self.voices[note].sustained = true;
        } else {
            self.voices[note].note.keyup();
        }
    }

    /// All notes off, oscillators re-synced (Dexed `panic`).
    pub fn panic(&mut self) {
        for voice in self.voices.iter_mut() {
            voice.midi_note = -1;
            voice.keydown = false;
            voice.live = false;
            voice.note.osc_sync();
        }
    }

    pub fn is_playing(&self) -> bool {
        self.voices.iter().any(|voice| voice.live && voice.note.is_playing())
    }

    /// Render one N-sample frame of the summed voices into `out` (mono, before the output stage).
    pub fn render_frame(&mut self, out: &mut [f32; N]) {
        self.flush_refresh();
        let mut audiobuf = [0i32; N];
        *out = [0.0; N];
        let lfovalue = self.lfo.getsample(&self.tables);
        let lfodelay = self.lfo.getdelay();
        let Synth {voices, controllers, core, tables, porta, engine, ..} = self;
        for voice in voices.iter_mut() {
            if voice.live {
                voice.note.compute(&mut audiobuf, lfovalue, lfodelay, controllers, tables, porta, core, *engine);
                for j in 0..N {
                    let val = audiobuf[j] >> 4;
                    // Dexed's clip: a negative overflow lands on +0x8000 (= +1.0), kept as is
                    let clip_val = if val < -(1 << 24) {0x8000} else if val >= (1 << 24) {0x7fff} else {val >> 9};
                    let mut f = clip_val as f32 / 0x8000 as f32;
                    if f > 1.0 {
                        f = 1.0;
                    }
                    if f < -1.0 {
                        f = -1.0;
                    }
                    out[j] += f;
                    audiobuf[j] = 0;
                }
            }
        }
    }

    pub fn tables(&self) -> &Tables {
        &self.tables
    }
}

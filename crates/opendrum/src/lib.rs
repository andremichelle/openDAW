//! The openDrum engines. Each engine is plain DSP over the common `dsp` blocks, without the device abi, so the
//! device crates, the reference lab and the editors' display wasm all run the same code.

#![cfg_attr(not(test), no_std)]

// what every engine does with its voices: where each sounding hit is, the Gate cut and the choke
macro_rules! voice_queries {
    ($params:ty, $release:expr $(, $after_cut:ident)?) => {
        /// The seconds since the start of every sounding hit, written into `output`; returns how many.
        pub fn positions(&self, output: &mut [f32]) -> usize {
            let mut count = 0;
            for voice in self.voices.iter().filter(|voice| voice.active).take(output.len()) {
                output[count] = voice.elapsed as f32 / self.sample_rate;
                count += 1;
            }
            count
        }

        /// In Gate the end of a note cuts its hit fast, in the other modes the hit plays on.
        pub fn note_off(&mut self, id: u32, params: &$params) {
            if params.play == Play::Gate {self.cut_voices(Some(id));}
        }

        /// Cuts every sounding hit as fast as a Gate note's end (another pad of its choke group fired).
        pub fn choke(&mut self) {self.cut_voices(None);}

        fn cut_voices(&mut self, id: Option<u32>) {
            let sample_rate = self.sample_rate;
            self.voices.iter_mut().filter(|voice| voice.active && id.map_or(true, |id| voice.id == id))
                .for_each(|voice| voice.cut.start($release, sample_rate));
            $(self.$after_cut(id);)?
        }
    };
}

pub mod bell;
pub mod clap;
pub mod common;
pub mod cymbal;
pub mod hat;
pub mod kick;
pub mod perc;
pub mod rim;
pub mod shaker;
pub mod snare;
pub mod tom;

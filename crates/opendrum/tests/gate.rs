//! Gate and choke in every engine: Gate plays the hit as Mono and cuts it at the note's end, a choke cuts it too.

use opendrum::bell::{Bell, BellParams};
use opendrum::clap::{Clap, ClapParams};
use opendrum::cymbal::{Cymbal, CymbalParams};
use opendrum::hat::{Hat, HatParams};
use opendrum::common::Play;
use opendrum::kick::{Kick, KickParams};
use opendrum::perc::{Perc, PercParams};
use opendrum::rim::{Rim, RimParams};
use opendrum::shaker::{Shaker, ShakerParams};
use opendrum::snare::{Snare, SnareParams};
use opendrum::tom::{Tom, TomParams};

const RATE: f32 = 48_000.0;
const HELD: usize = 4_800;
const AFTER: usize = 960;

macro_rules! gate {
    ($name:ident, $engine:ident, $params:ident, |$hit:ident, $values:ident| $note_on:expr, |$out:ident| $process:expr) => {
        #[test]
        fn $name() {
            let render = |play: Play, release: bool| {
                let $values = $params {play, ..$params::default()};
                let mut $hit = $engine::new(RATE);
                $note_on;
                let mut held = vec![0.0; HELD];
                {let $out = &mut held; $process;}
                let mut after = vec![0.0; AFTER];
                if release {$hit.note_off(1, &$values);}
                {let $out = &mut after; $process;}
                (held, after, $hit.is_silent())
            };
            let (mono, _, _) = render(Play::Mono, false);
            let (gate, after, silent) = render(Play::Gate, true);
            assert_eq!(mono, gate, "a held note plays the hit unchanged");
            assert!(silent, "the note's end has cut the hit");
            let left = after[AFTER - 100..].iter().fold(0.0f32, |peak, value| peak.max(value.abs()));
            assert!(left < 0.001, "and nothing is left but a filter fading out, {left}");
            let $values = $params {play: Play::Mono, ..$params::default()};
            let mut $hit = $engine::new(RATE);
            $note_on;
            let mut held = vec![0.0; HELD];
            {let $out = &mut held; $process;}
            $hit.choke();
            let mut after = vec![0.0; AFTER];
            {let $out = &mut after; $process;}
            assert!($hit.is_silent(), "a choke cuts the hit in any mode");
        }
    };
}

gate!(kick, Kick, KickParams, |hit, values| hit.note_on(1, 1.0, 0.0, &values), |out| hit.process(&values, 120.0, out));
gate!(snare, Snare, SnareParams, |hit, values| hit.note_on(1, 1.0, 0.0, &values), |out| hit.process(&values, out));
gate!(clap, Clap, ClapParams, |hit, values| hit.note_on(1, 1.0, 0.0, &values), |out| hit.process(&values, out));
gate!(tom, Tom, TomParams, |hit, values| hit.note_on(1, 1.0, 0.0, &values), |out| hit.process(&values, out));
gate!(rim, Rim, RimParams, |hit, values| hit.note_on(1, 1.0, 0.0, &values), |out| hit.process(&values, out));
gate!(hat, Hat, HatParams, |hit, values| hit.note_on(1, 1.0, 0.0, &values), |out| hit.process(&values, out));
gate!(shaker, Shaker, ShakerParams, |hit, values| hit.note_on(1, 1.0, 0.0, &values), |out| hit.process(&values, out));
gate!(cymbal, Cymbal, CymbalParams, |hit, values| hit.note_on(1, 1.0, 0.0, &values), |out| hit.process(&values, out));
gate!(bell, Bell, BellParams, |hit, values| hit.note_on(1, 1.0, 0.0, &values), |out| hit.process(&values, out));
gate!(perc, Perc, PercParams, |hit, values| hit.note_on(1, 1.0, 0.0, &values), |out| hit.process(&values, out));

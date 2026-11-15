use opendrum::common::Play;
use opendrum::kick::{Kick, KickParams};
use std::io::Write;

fn main() {
    let path = std::env::args().nth(1).unwrap();
    let mut file = std::fs::File::create(path).unwrap();
    let base = KickParams::default();
    let sets = [
        base,
        KickParams {click: 1.0, drive: 12.0, skin: 0.5, rumble: 1.0, punch: -0.5, noise: 0.8, ..base},
        KickParams {click: 0.4, drive: 3.0, punch: 0.7, shape: 0.8, play: Play::Poly, bright: 0.9, ..base}
    ];
    for params in sets {
        let mut kick = Kick::new(48_000.0);
        kick.note_on(1, 0.8, 0.0, &params);
        let mut output = vec![0.0f32; 24_000];
        kick.process(&params, 120.0, &mut output);
        kick.note_on(2, 1.0, 7.0, &params);
        let mut more = vec![0.0f32; 24_000];
        kick.process(&params, 120.0, &mut more);
        for value in output.iter().chain(more.iter()) {file.write_all(&value.to_le_bytes()).unwrap();}
    }
}

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Machine {
    Tr808,
    Tr909
}

impl Machine {
    pub fn label(&self) -> &'static str {
        match self {
            Machine::Tr808 => "808",
            Machine::Tr909 => "909"
        }
    }
}

#[derive(Clone, Debug)]
pub struct Reference {
    pub machine: Machine,
    pub voice: &'static str,
    pub name: String,
    pub knobs: Vec<(&'static str, f64)>,
    pub path: PathBuf
}

/// `OPENDRUM_REFERENCES`, else `~/Documents/Resources/samples`.
pub fn root() -> PathBuf {
    env::var_os("OPENDRUM_REFERENCES").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(env::var_os("HOME").unwrap_or_default()).join("Documents/Resources/samples")
    })
}

const VOICES_808: [(&str, &str, &[&str]); 11] = [
    ("BD", "kick", &["tone", "decay"]),
    ("SD", "snare", &["tone", "snappy"]),
    ("LT", "tom-low", &["tune"]),
    ("MT", "tom-mid", &["tune"]),
    ("HT", "tom-high", &["tune"]),
    ("LC", "conga-low", &["tune"]),
    ("MC", "conga-mid", &["tune"]),
    ("HC", "conga-high", &["tune"]),
    ("RS", "rim", &[]),
    ("CL", "claves", &[]),
    ("CP", "clap", &[])
];

const VOICES_909: [(&str, &str, &[&str]); 7] = [
    ("BT", "kick", &["tune", "attack", "decay"]),
    ("ST", "snare", &["tune", "tone", "snappy"]),
    ("LT", "tom-low", &["tune", "decay"]),
    ("MT", "tom-mid", &["tune", "decay"]),
    ("HT", "tom-high", &["tune", "decay"]),
    ("RIM", "rim", &["velocity"]),
    ("HANDCLP", "clap", &["take"])
];

fn wav_names(folder: &Path) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = fs::read_dir(folder).map_err(|error| format!("{}: {error}", folder.display()))?
        .filter_map(|entry| entry.ok().map(|entry| entry.file_name().to_string_lossy().to_string()))
        .filter(|name| name.to_uppercase().ends_with(".WAV"))
        .collect();
    names.sort();
    Ok(names)
}

fn stem(name: &str) -> String {name[..name.len() - 4].to_uppercase()}

/// 808 file names carry two digits per knob: 00, 25, 50, 75 and 10 (the maximum).
fn knobs_808(digits: &str, names: &[&'static str]) -> Option<Vec<(&'static str, f64)>> {
    if digits.len() != names.len() * 2 {return None;}
    names.iter().enumerate().map(|(index, name)| {
        let value = match &digits[index * 2..index * 2 + 2] {
            "10" => 1.0,
            pair => pair.parse::<f64>().ok()? / 100.0
        };
        Some((*name, value))
    }).collect()
}

/// 909 file names carry a letter and a digit per knob, `A` is the maximum (10).
fn knobs_909(pairs: &str, names: &[&'static str]) -> Option<Vec<(&'static str, f64)>> {
    let chars: Vec<char> = pairs.chars().collect();
    if chars.len() != names.len() * 2 {return None;}
    names.iter().enumerate().map(|(index, name)| {
        let value = match chars[index * 2 + 1] {
            'A' => 1.0,
            digit => digit.to_digit(10)? as f64 / 10.0
        };
        Some((*name, value))
    }).collect()
}

/// Many files of the 909 set start with about 21 samples of garbage (the set's own notes mention broken headers):
/// jumps of over 30 % of the peak between neighbours. The real hit starts smoothly after them.
pub fn trim_garbage_start(samples: &[f64]) -> &[f64] {
    let peak = samples.iter().take(4410).fold(0.0f64, |peak, value| peak.max(value.abs()));
    if peak <= 0.0 || samples.len() < 24 {return samples;}
    let jumps = (1..24).filter(|index| (samples[*index] - samples[index - 1]).abs() > 0.3 * peak).count();
    if jumps >= 5 {&samples[22..]} else {samples}
}

pub fn all(root: &Path) -> Result<Vec<Reference>, String> {
    let mut references = Vec::new();
    let folder_808 = root.join("TR808WAV");
    for (code, voice, knob_names) in VOICES_808 {
        let folder = folder_808.join(code);
        for name in wav_names(&folder)? {
            let knobs = knobs_808(&stem(&name)[code.len()..], knob_names)
                .ok_or_else(|| format!("808 {name}: unexpected knob digits"))?;
            references.push(Reference {machine: Machine::Tr808, voice, name: stem(&name), knobs, path: folder.join(&name)});
        }
    }
    let folder_909 = root.join("Roland TR-909");
    let names_909 = wav_names(&folder_909)?;
    for (prefix, voice, knob_names) in VOICES_909 {
        for name in names_909.iter().filter(|name| stem(name).starts_with(prefix)) {
            let rest = &stem(name)[prefix.len()..];
            let knobs = match voice {
                "rim" => rest.parse::<f64>().ok().map(|velocity| vec![(knob_names[0], velocity / 127.0)]),
                "clap" => rest.parse::<f64>().ok().map(|take| vec![(knob_names[0], take)]),
                _ => knobs_909(&stem(name)[1..], knob_names)
            }.ok_or_else(|| format!("909 {name}: unexpected knob letters"))?;
            references.push(Reference {machine: Machine::Tr909, voice, name: stem(name), knobs, path: folder_909.join(name)});
        }
    }
    Ok(references)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_808_knobs() {
        assert_eq!(knobs_808("2510", &["tone", "decay"]), Some(vec![("tone", 0.25), ("decay", 1.0)]));
        assert_eq!(knobs_808("75", &["tune"]), Some(vec![("tune", 0.75)]));
        assert_eq!(knobs_808("", &[]), Some(vec![]));
        assert_eq!(knobs_808("251", &["tone", "decay"]), None);
    }

    #[test]
    fn trims_only_a_garbage_start() {
        let mut garbage: Vec<f64> = (0..22).map(|index| if index % 2 == 0 {0.8} else {-0.6}).collect();
        garbage.extend((0..100).map(|index| index as f64 * 0.01));
        assert_eq!(trim_garbage_start(&garbage).len(), 100);
        let smooth: Vec<f64> = (0..200).map(|index| (index as f64 * 0.05).sin()).collect();
        assert_eq!(trim_garbage_start(&smooth).len(), 200);
    }

    #[test]
    fn parses_909_knobs() {
        assert_eq!(knobs_909("T3A0DA", &["tune", "attack", "decay"]), Some(vec![("tune", 0.3), ("attack", 0.0), ("decay", 1.0)]));
        assert_eq!(knobs_909("T0A0A7", &["tune", "attack", "decay"]), Some(vec![("tune", 0.0), ("attack", 0.0), ("decay", 0.7)]));
        assert_eq!(knobs_909("TAD", &["tune", "decay"]), None);
    }
}

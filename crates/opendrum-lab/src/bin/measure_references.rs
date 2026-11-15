//! Measures every 808 and 909 reference hit and writes one row per hit to `measured/references.tsv`.
//! Run: cargo run -p opendrum-lab --release --bin measure_references

use opendrum_lab::measure::{measure, Measures, CENTROID_TIMES_MS, OCTAVE_CENTRES, PARTIAL_COUNT, PITCH_TIMES_MS};
use opendrum_lab::references;
use opendrum_lab::wav::read_mono;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

fn header() -> String {
    let mut columns: Vec<String> = ["machine", "voice", "name", "knobs", "onset_ms", "peak_ms", "decay3_ms", "decay20_ms", "decay40_ms", "length_ms"]
        .iter().map(|name| name.to_string()).collect();
    columns.extend(["first_period_ms".to_string(), "first_period_hz".to_string()]);
    columns.extend(PITCH_TIMES_MS.iter().map(|ms| format!("pitch_{ms}ms")));
    columns.extend((1..=PARTIAL_COUNT).flat_map(|index| [format!("partial{index}_hz"), format!("partial{index}_db")]));
    columns.extend(CENTROID_TIMES_MS.iter().map(|ms| format!("centroid_{ms}ms")));
    columns.push("attack_centroid".into());
    columns.extend(OCTAVE_CENTRES.iter().map(|hz| format!("early_{hz}")));
    columns.extend(OCTAVE_CENTRES.iter().map(|hz| format!("late_{hz}")));
    columns.extend(["noise_early_db", "noise_late_db", "noise_low_early_db", "noise_low_late_db", "bursts_ms"].iter().map(|name| name.to_string()));
    columns.join("\t")
}

fn row(measures: &Measures) -> Vec<String> {
    let number = |value: f64| if value.is_finite() {format!("{value:.1}")} else {"-".into()};
    let mut cells = vec![number(measures.onset_ms), number(measures.peak_ms), number(measures.decay3_ms), number(measures.decay20_ms),
                         number(measures.decay40_ms), number(measures.length_ms)];
    cells.extend([number(measures.first_period.0), number(measures.first_period.1)]);
    cells.extend(measures.pitch_hz.iter().map(|hz| number(*hz)));
    cells.extend((0..PARTIAL_COUNT).flat_map(|index| match measures.partials.get(index) {
        Some((hz, db)) => [number(*hz), number(*db)],
        None => ["-".into(), "-".into()]
    }));
    cells.extend(measures.centroid_hz.iter().map(|hz| number(*hz)));
    cells.push(number(measures.attack_centroid_hz));
    cells.extend(measures.bands_early_db.iter().map(|db| number(*db)));
    cells.extend(measures.bands_late_db.iter().map(|db| number(*db)));
    cells.push(number(measures.noise_early_db));
    cells.push(number(measures.noise_late_db));
    cells.push(number(measures.noise_low_early_db));
    cells.push(number(measures.noise_low_late_db));
    cells.push(measures.bursts_ms.iter().map(|ms| format!("{ms:.1}")).collect::<Vec<_>>().join(","));
    cells
}

fn main() -> ExitCode {
    let root = references::root();
    let all = match references::all(&root) {
        Ok(all) => all,
        Err(error) => {
            eprintln!("references at {}: {error}", root.display());
            return ExitCode::FAILURE;
        }
    };
    let mut lines = vec![header()];
    for reference in &all {
        let audio = match read_mono(&reference.path) {
            Ok(audio) => audio,
            Err(error) => {
                eprintln!("{error}");
                return ExitCode::FAILURE;
            }
        };
        let knobs = reference.knobs.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join(" ");
        let mut cells = vec![reference.machine.label().to_string(), reference.voice.to_string(), reference.name.clone(), knobs];
        cells.extend(row(&measure(references::trim_garbage_start(&audio.samples), audio.sample_rate)));
        lines.push(cells.join("\t"));
    }
    let target = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("measured/references.tsv");
    if let Err(error) = fs::create_dir_all(target.parent().unwrap()).and_then(|_| fs::write(&target, lines.join("\n") + "\n")) {
        eprintln!("{}: {error}", target.display());
        return ExitCode::FAILURE;
    }
    println!("{} references measured into {}", all.len(), target.display());
    ExitCode::SUCCESS
}

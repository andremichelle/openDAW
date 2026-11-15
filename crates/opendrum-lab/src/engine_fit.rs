//! The fitter every engine uses: normalised axes, seeded Nelder-Mead rounds, all cores in parallel, a printed report
//! per reference and a table of all fits. An engine names its voice, its axes, how a point renders and its seeds.

use crate::fit::{distance, misses, nelder_mead, Card};
use crate::measure::{band_grid, measure, strongest_tones, Measures, GRID_EDGES, GRID_FRAMES_MS};
use crate::references::{self, Reference};
use crate::wav::read_mono;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;

pub struct Axis {
    pub name: &'static str,
    pub min: f64,
    pub max: f64,
    pub log: bool
}

impl Axis {
    pub fn value(&self, unit: f64) -> f64 {
        if self.log {self.min * (self.max / self.min).powf(unit)} else {self.min + (self.max - self.min) * unit}
    }

    pub fn unit(&self, value: f64) -> f64 {
        if self.log {(value / self.min).ln() / (self.max / self.min).ln()} else {(value - self.min) / (self.max - self.min)}
    }
}

pub trait Engine: Sync {
    fn voice(&self) -> &'static str;
    fn card(&self) -> Card {Card::OneBody}
    fn axes(&self) -> &[Axis];
    /// Renders one hit with the parameter `values` (in axis units, not normalised).
    fn render(&self, values: &[f64], sample_rate: f64, seconds: f64) -> Vec<f64>;
    /// Starting points in axis units, some derived from the reference.
    fn starts(&self, reference: &Measures) -> Vec<Vec<f64>>;
}

fn values(engine: &dyn Engine, point: &[f64]) -> Vec<f64> {
    engine.axes().iter().zip(point.iter()).map(|(axis, unit)| axis.value(*unit)).collect()
}

fn fit(engine: &dyn Engine, reference: &Measures, sample_rate: f64, seconds: f64) -> (Vec<f64>, f64) {
    let cost = |point: &[f64]| distance(reference, &measure(&engine.render(&values(engine, point), sample_rate, seconds), sample_rate), engine.card());
    let mut best: (Vec<f64>, f64) = (Vec::new(), f64::MAX);
    for start in engine.starts(reference) {
        let mut point: Vec<f64> = start.iter().zip(engine.axes().iter()).map(|(value, axis)| axis.unit(*value)).collect();
        let mut step = 0.2;
        for _ in 0..3 {
            let (found, found_cost) = nelder_mead(&point, step, 700, cost);
            point = found;
            if found_cost < best.1 {best = (point.clone(), found_cost);}
            step *= 0.5;
        }
    }
    best
}

/// Fits one reference: the printed report and the table row.
fn fit_one(engine: &dyn Engine, reference: &Reference) -> Result<(String, String), String> {
    let audio = read_mono(&reference.path)?;
    let samples = references::trim_garbage_start(&audio.samples);
    let seconds = samples.len() as f64 / audio.sample_rate + 0.2;
    let target = measure(samples, audio.sample_rate);
    let (point, cost) = fit(engine, &target, audio.sample_rate, seconds);
    let fitted = values(engine, &point);
    let candidate = measure(&engine.render(&fitted, audio.sample_rate, seconds), audio.sample_rate);
    let all_misses = misses(&target, &candidate, engine.card());
    let within = all_misses.iter().filter(|miss| miss.units.abs() <= 1.0).count();
    let mut report = vec![
        format!("{} {} distance {cost:.1} over {} dimensions", reference.machine.label(), reference.name, all_misses.len()),
        format!("  {}", engine.axes().iter().zip(fitted.iter()).map(|(axis, value)| format!("{} {value:.4}", axis.name))
            .collect::<Vec<_>>().join(", "))
    ];
    let mut sorted = all_misses.clone();
    sorted.sort_by(|a, b| b.units.abs().total_cmp(&a.units.abs()));
    report.extend(sorted.iter().take(8).map(|miss|
        format!("  {:<18} reference {:>9.1}  {} {:>9.1}  {:+.2}", miss.name, miss.reference, engine.voice(), miss.candidate, miss.units)));
    report.push(format!("  within tolerance: {within} of {}", all_misses.len()));
    if env::var_os("OPENDRUM_TONES").is_some() {
        let ours = engine.render(&fitted, audio.sample_rate, seconds);
        for (from, to) in [(0.0, 50.0), (50.0, 150.0)] {
            let print = |tones: Vec<(f64, f64)>| tones.iter().map(|(hz, db)| format!("{hz:.0} {db:.0}")).collect::<Vec<_>>().join(" | ");
            report.push(format!("  tones {from}-{to} ms reference {}", print(strongest_tones(samples, audio.sample_rate, from, to))));
            report.push(format!("  tones {from}-{to} ms {:<9} {}", engine.voice(), print(strongest_tones(&ours, audio.sample_rate, from, to))));
        }
    }
    if env::var_os("OPENDRUM_BANDS").is_some() {
        let (want, have) = (band_grid(samples, audio.sample_rate), band_grid(&engine.render(&fitted, audio.sample_rate, seconds), audio.sample_rate));
        report.push(format!("  bands, reference/{} (difference), dB under the loudest cell", engine.voice()));
        report.push(format!("     ms {}", GRID_EDGES.windows(2).map(|edge| format!("{:>14}", format!("{}-{}", edge[0] as i32, edge[1] as i32))).collect::<String>()));
        for (frame, ms) in GRID_FRAMES_MS.iter().enumerate() {
            report.push(format!("  {:>5} {}", ms, (0..GRID_EDGES.len() - 1).map(|band| {
                let (a, b) = (want[frame][band], have[frame][band]);
                format!("{:>5.0}/{:>4.0}({:>+3.0})", a, b, b - a)
            }).collect::<String>()));
        }
    }
    let knobs = reference.knobs.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join(" ");
    let row = format!("{}\t{}\t{knobs}\t{cost:.1}\t{within}\t{}\t{}", reference.machine.label(), reference.name,
                      all_misses.len(), fitted.iter().map(|value| format!("{value:.4}")).collect::<Vec<_>>().join("\t"));
    Ok((report.join("\n"), row))
}

/// The command line of a fit binary: reference names, or `all` to fit every reference of the voice and write
/// `measured/<table>`.
pub fn run(engine: &dyn Engine, table: &str) -> ExitCode {
    let all = match references::all(&references::root()) {
        Ok(all) => all,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let arguments: Vec<String> = env::args().skip(1).map(|name| name.to_uppercase()).collect();
    let write_all = arguments.iter().any(|name| name == "ALL");
    let selected: Vec<&Reference> = all.iter()
        .filter(|reference| reference.voice == engine.voice() && (write_all || arguments.contains(&reference.name)))
        .collect();
    if !write_all && selected.len() != arguments.len() {
        eprintln!("unknown {} reference in {arguments:?}", engine.voice());
        return ExitCode::FAILURE;
    }
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<Result<(String, String), String>>>> = Mutex::new(vec![None; selected.len()]);
    let workers = thread::available_parallelism().map(|count| count.get()).unwrap_or(4);
    thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(reference) = selected.get(index) else {break;};
                let result = fit_one(engine, reference);
                if let Ok((report, _)) = &result {println!("{report}");}
                if let Ok(mut results) = results.lock() {results[index] = Some(result);}
            });
        }
    });
    let mut rows = vec![format!("machine\tname\tknobs\tdistance\twithin\tdimensions\t{}",
                                engine.axes().iter().map(|axis| axis.name).collect::<Vec<_>>().join("\t"))];
    for result in results.into_inner().unwrap_or_default().into_iter().flatten() {
        match result {
            Ok((_, row)) => rows.push(row),
            Err(error) => {
                eprintln!("{error}");
                return ExitCode::FAILURE;
            }
        }
    }
    if write_all {
        let target = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("measured").join(table);
        if let Err(error) = fs::write(&target, rows.join("\n") + "\n") {
            eprintln!("{}: {error}", target.display());
            return ExitCode::FAILURE;
        }
        println!("written {}", target.display());
    }
    ExitCode::SUCCESS
}

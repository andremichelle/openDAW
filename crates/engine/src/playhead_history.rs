//! Where the playhead was during the last quanta (#482): a processor whose input is late by `lag` frames
//! resolves its automation and modulation at the timeline position that audio was rendered at, exact across
//! tempo changes, loop jumps and locates.

use alloc::vec;
use alloc::vec::Vec;
use engine_env::block::Block;

#[derive(Clone, Copy, Default)]
struct Record {
    start: u64,
    frames: u32,
    p0: f64,
    p1: f64,
    song: f64,
    transporting: bool,
    quantum: u64
}

/// The positions a lagged reader resolves at: the automation (the song position while paused), the modulation
/// (the block's pulse) and how many quanta back the audio was rendered, for the modulators' value history.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Lagged {
    pub(crate) automation: f64,
    pub(crate) modulation: f64,
    pub(crate) quanta_back: usize
}

pub(crate) struct PlayheadHistory {
    records: Vec<Record>,
    head: usize,
    count: usize,
    quantum: u64,
    quantum_start: u64
}

impl PlayheadHistory {
    pub(crate) const fn new() -> Self {
        Self {records: Vec::new(), head: 0, count: 0, quantum: 0, quantum_start: 0}
    }

    /// Sized outside render for `quanta` quanta of up to `blocks_per_quantum` blocks each.
    pub(crate) fn reserve(&mut self, quanta: usize, blocks_per_quantum: usize) {
        self.records = vec![Record::default(); quanta * blocks_per_quantum];
        self.head = 0;
        self.count = 0;
    }

    pub(crate) fn record_quantum(&mut self, blocks: &[Block], song: f64, quantum_frames: u32) {
        if self.records.is_empty() {
            return;
        }
        if self.count > 0 {
            self.quantum += 1;
            self.quantum_start += quantum_frames as u64;
        }
        for block in blocks {
            self.records[self.head] = Record {
                start: self.quantum_start + block.s0 as u64,
                frames: block.s1 - block.s0,
                p0: block.p0,
                p1: block.p1,
                song: if block.flags.transporting() {block.p0} else {song},
                transporting: block.flags.transporting(),
                quantum: self.quantum
            };
            self.head = (self.head + 1) % self.records.len();
            self.count = (self.count + 1).min(self.records.len());
        }
    }

    fn newest(&self, back: usize) -> &Record {
        &self.records[(self.head + self.records.len() - 1 - back) % self.records.len()]
    }

    /// Resolve `position` (a pulse inside the current quantum) `lag` frames earlier.
    pub(crate) fn lagged(&self, position: f64, lag: u32) -> Option<Lagged> {
        if self.count == 0 {
            return None;
        }
        let frame = (0..self.count)
            .map(|back| self.newest(back))
            .take_while(|record| record.quantum == self.quantum)
            .find(|record| record.p0 <= position && position <= record.p1)
            .map_or(self.quantum_start, |record| {
                let span = record.p1 - record.p0;
                let offset = if span > 0.0 {(position - record.p0) / span * record.frames as f64} else {0.0};
                record.start + offset as u64
            });
        let target = frame.saturating_sub(lag as u64);
        let record = (0..self.count)
            .map(|back| self.newest(back))
            .find(|record| record.start <= target)
            .unwrap_or_else(|| self.newest(self.count - 1));
        let ratio = if record.frames == 0 {0.0} else {(target.saturating_sub(record.start)) as f64 / record.frames as f64};
        let pulse = record.p0 + (record.p1 - record.p0) * ratio.min(1.0);
        Some(Lagged {
            automation: if record.transporting {pulse} else {record.song},
            modulation: pulse,
            quanta_back: (self.quantum - record.quantum) as usize
        })
    }
}

#[cfg(test)]
mod tests {
    use engine_env::block_flags::BlockFlags;
    use super::*;

    fn block(p0: f64, p1: f64, s0: u32, s1: u32) -> Block {
        Block {index: 0, flags: BlockFlags::create(true, false, true, false), p0, p1, s0, s1, bpm: 120.0}
    }

    #[test]
    fn steps_back_across_quanta_at_a_constant_tempo() {
        let mut history = PlayheadHistory::new();
        history.reserve(8, 4);
        for quantum in 0..4 {
            let p0 = quantum as f64 * 128.0;
            history.record_quantum(&[block(p0, p0 + 128.0, 0, 128)], 0.0, 128);
        }
        let lagged = history.lagged(384.0 + 64.0, 200).unwrap();
        assert_eq!(lagged.automation, 248.0);
        assert_eq!(lagged.modulation, 248.0);
        assert_eq!(lagged.quanta_back, 2);
    }

    #[test]
    fn follows_a_tempo_change_inside_a_quantum() {
        let mut history = PlayheadHistory::new();
        history.reserve(8, 4);
        history.record_quantum(&[block(0.0, 64.0, 0, 64), block(64.0, 192.0, 64, 128)], 0.0, 128);
        history.record_quantum(&[block(192.0, 448.0, 0, 128)], 0.0, 128);
        assert_eq!(history.lagged(192.0, 32).unwrap().automation, 128.0);
        assert_eq!(history.lagged(192.0, 96).unwrap().automation, 32.0);
    }

    #[test]
    fn reads_the_loop_end_after_a_loop_jump() {
        let mut history = PlayheadHistory::new();
        history.reserve(8, 4);
        history.record_quantum(&[block(900.0, 1000.0, 0, 100), block(0.0, 28.0, 100, 128)], 0.0, 128);
        let lagged = history.lagged(20.0, 30).unwrap();
        assert_eq!(lagged.automation, 990.0);
        assert_eq!(lagged.quanta_back, 0);
    }

    #[test]
    fn a_paused_block_reads_the_frozen_song_position() {
        let mut history = PlayheadHistory::new();
        history.reserve(8, 4);
        let paused = Block {index: 0, flags: BlockFlags::create(false, false, false, false), p0: 5000.0, p1: 5128.0, s0: 0, s1: 128, bpm: 120.0};
        history.record_quantum(&[paused], 777.0, 128);
        history.record_quantum(&[block(777.0, 905.0, 0, 128)], 777.0, 128);
        let lagged = history.lagged(777.0, 64).unwrap();
        assert_eq!(lagged.automation, 777.0);
        assert_eq!(lagged.modulation, 5064.0);
        assert_eq!(lagged.quanta_back, 1);
    }

    #[test]
    fn a_lag_beyond_the_history_reads_the_oldest_record() {
        let mut history = PlayheadHistory::new();
        history.reserve(2, 1);
        for quantum in 0..4 {
            let p0 = quantum as f64 * 128.0;
            history.record_quantum(&[block(p0, p0 + 128.0, 0, 128)], 0.0, 128);
        }
        assert_eq!(history.lagged(400.0, 10_000).unwrap().automation, 256.0);
    }
}

//! A Playfield pad's note route between the Playfield's midi-fx and the pad's: its key in, played as its `key`.

use alloc::rc::Rc;
use core::cell::{Cell, RefCell};
use abi::{EventRecord, EVENT_CHOKE, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use engine_env::telemetry::BroadcastSlot;

pub(crate) const MAX_HELD: usize = 64;

struct Held {
    notes: [(u32, u32); MAX_HELD], // (note id, routed pitch)
    len: usize,
    evicted: [Option<(u32, u32)>; MAX_HELD], // a full table's oldest notes, still awaiting their note-off
    next_evicted: usize
}

impl Held {
    fn push(&mut self, id: u32, pitch: u32) {
        if self.len == MAX_HELD {
            self.evicted[self.next_evicted] = Some(self.notes[0]);
            self.next_evicted = (self.next_evicted + 1) % MAX_HELD;
            self.notes.copy_within(1.., 0);
            self.len -= 1;
        }
        self.notes[self.len] = (id, pitch);
        self.len += 1;
    }

    fn take(&mut self, id: u32) -> Option<u32> {
        match self.notes[..self.len].iter().position(|(held, _)| *held == id) {
            Some(index) => {
                let pitch = self.notes[index].1;
                self.notes.copy_within(index + 1..self.len, index);
                self.len -= 1;
                Some(pitch)
            }
            None => self.evicted.iter_mut().find(|entry| entry.is_some_and(|(held, _)| held == id))
                .and_then(|entry| entry.take()).map(|(_, pitch)| pitch)
        }
    }
}

pub(crate) struct PadRouter {
    pad_key: Cell<i32>,
    play_key: Rc<Cell<i32>>,
    choke: RefCell<Rc<[i32]>>,
    gate: Rc<Cell<bool>>,
    held: RefCell<Held>,
    note_bits: Option<BroadcastSlot>,
    marks: Cell<bool> // one pad per Playfield marks the unit's notes
}

impl PadRouter {
    pub(crate) fn new(gate: Rc<Cell<bool>>, note_bits: Option<BroadcastSlot>) -> Self {
        Self {pad_key: Cell::new(-1), play_key: Rc::new(Cell::new(60)), choke: RefCell::new(Rc::from([])), gate,
            held: RefCell::new(Held {notes: [(0, 0); MAX_HELD], len: 0, evicted: [None; MAX_HELD], next_evicted: 0}),
            note_bits, marks: Cell::new(false)}
    }

    pub(crate) fn set_pad_key(&self, key: i32) {
        self.pad_key.set(key);
    }

    pub(crate) fn set_marks(&self, marks: bool) {
        if self.marks.replace(marks) && !marks {
            if let Some(slot) = &self.note_bits {engine_env::telemetry::clear_note_bits(slot)}
        }
    }

    pub(crate) fn play_key(&self) -> Rc<Cell<i32>> {
        self.play_key.clone()
    }

    pub(crate) fn set_choke(&self, choke: &[i32]) {
        if self.choke.borrow()[..] != *choke {
            *self.choke.borrow_mut() = Rc::from(choke);
        }
    }

    /// Routes in place (one record in, at most one out) and returns the count kept.
    pub(crate) fn route(&self, records: &mut [EventRecord]) -> usize {
        let (pad_key, play_key) = (self.pad_key.get(), self.play_key.get().clamp(0, 127) as u32);
        let choke = self.choke.borrow();
        let mut held = self.held.borrow_mut();
        let mut count = 0;
        for index in 0..records.len() {
            let record = records[index];
            let routed = if record.kind == EVENT_NOTE_ON {
                self.mark(record.pitch, true);
                if record.pitch as i32 == pad_key {
                    if self.gate.get() {
                        None
                    } else {
                        held.push(record.id, play_key);
                        Some(EventRecord {pitch: play_key, ..record})
                    }
                } else if choke.contains(&(record.pitch as i32)) {
                    Some(EventRecord {position: record.position, offset: record.offset, kind: EVENT_CHOKE, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0})
                } else {
                    None
                }
            } else if record.kind == EVENT_NOTE_OFF {
                self.mark(record.pitch, false);
                held.take(record.id).map(|pitch| EventRecord {pitch, ..record})
            } else {
                Some(record)
            };
            if let Some(routed) = routed {
                records[count] = routed;
                count += 1;
            }
        }
        count
    }

    fn mark(&self, pitch: u32, on: bool) {
        if !self.marks.get() {return}
        if let Some(slot) = &self.note_bits {
            engine_env::telemetry::set_note_bit(slot, pitch as i32, on);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    fn note(kind: u32, id: u32, pitch: u32) -> EventRecord {
        EventRecord {position: id as f64, offset: 0, kind, id, pitch, velocity: 1.0, cent: 0.0, duration: 0.0}
    }

    fn router(pad_key: i32, play_key: i32) -> PadRouter {
        let router = PadRouter::new(Rc::new(Cell::new(false)), None);
        router.set_pad_key(pad_key);
        router.play_key().set(play_key);
        router
    }

    fn routed(router: &PadRouter, records: &[EventRecord]) -> Vec<EventRecord> {
        let mut records = records.to_vec();
        let count = router.route(&mut records);
        records.truncate(count);
        records
    }

    #[test]
    fn only_the_pad_key_passes_and_plays_as_the_key() {
        let router = router(36, 60);
        let out = routed(&router, &[note(EVENT_NOTE_ON, 1, 35), note(EVENT_NOTE_ON, 2, 36), note(EVENT_NOTE_OFF, 1, 35), note(EVENT_NOTE_OFF, 2, 36)]);
        assert_eq!(out.len(), 2);
        assert_eq!((out[0].kind, out[0].id, out[0].pitch), (EVENT_NOTE_ON, 2, 60));
        assert_eq!((out[1].kind, out[1].id, out[1].pitch), (EVENT_NOTE_OFF, 2, 60));
    }

    #[test]
    fn a_key_edit_during_a_sounding_note_releases_the_played_pitch() {
        let router = router(36, 60);
        routed(&router, &[note(EVENT_NOTE_ON, 1, 36)]);
        router.play_key().set(72);
        router.set_pad_key(40);
        let out = routed(&router, &[note(EVENT_NOTE_OFF, 1, 36)]);
        assert_eq!((out[0].kind, out[0].pitch), (EVENT_NOTE_OFF, 60));
        let out = routed(&router, &[note(EVENT_NOTE_ON, 2, 40), note(EVENT_NOTE_OFF, 2, 40)]);
        assert_eq!((out[0].pitch, out[1].pitch), (72, 72));
    }

    #[test]
    fn a_sibling_exclude_key_chokes() {
        let router = router(36, 60);
        router.set_choke(&[38, 42]);
        let out = routed(&router, &[note(EVENT_NOTE_ON, 1, 38), note(EVENT_NOTE_ON, 2, 40), note(EVENT_NOTE_OFF, 1, 38)]);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].kind, out[0].position), (EVENT_CHOKE, 1.0));
    }

    #[test]
    fn a_silent_pad_drops_note_ons_and_their_note_offs_but_ends_sounding_notes() {
        let gate = Rc::new(Cell::new(false));
        let router = PadRouter::new(gate.clone(), None);
        router.set_pad_key(36);
        routed(&router, &[note(EVENT_NOTE_ON, 1, 36)]);
        gate.set(true);
        let out = routed(&router, &[note(EVENT_NOTE_ON, 2, 36), note(EVENT_NOTE_OFF, 1, 36), note(EVENT_NOTE_OFF, 2, 36)]);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].kind, out[0].id, out[0].pitch), (EVENT_NOTE_OFF, 1, 60));
    }

    #[test]
    fn a_full_table_still_releases_its_oldest_notes_after_the_pad_moved() {
        let router = router(36, 60);
        let starts: Vec<EventRecord> = (0..MAX_HELD as u32 + 1).map(|id| note(EVENT_NOTE_ON, id, 36)).collect();
        routed(&router, &starts);
        router.play_key().set(64);
        router.set_pad_key(40);
        let out = routed(&router, &[note(EVENT_NOTE_OFF, 0, 36), note(EVENT_NOTE_OFF, 1, 36)]);
        assert_eq!((out.len(), out[0].pitch, out[1].pitch), (2, 60, 60));
    }

    #[test]
    fn other_records_pass_unchanged() {
        let router = router(36, 60);
        let choke = EventRecord {kind: EVENT_CHOKE, ..note(EVENT_NOTE_ON, 0, 0)};
        assert_eq!(routed(&router, &[choke]).len(), 1);
    }
}

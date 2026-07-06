//! Tempo automation in the block renderer: no map yields one fixed-bpm block; a tempo map with a
//! change at a grid point splits the quantum into two blocks at the old then new bpm.

use transport::transport::{Block, Transport, RENDER_QUANTUM, TEMPO_CHANGE_GRID};
use value::event::EventCollection;
use value::value::{Interpolation, ValueEvent};

fn collect(transport: &mut Transport, tempo: Option<&EventCollection<ValueEvent>>) -> Vec<Block> {
    let mut blocks = Vec::new();
    transport.render_quantum(tempo, &[], false, |block| blocks.push(*block));
    blocks
}

#[test]
fn no_tempo_map_yields_one_fixed_block() {
    let mut transport = Transport::new(48000.0, 120.0);
    transport.play();
    let blocks = collect(&mut transport, None);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].bpm, 120.0);
    assert_eq!((blocks[0].s0, blocks[0].s1), (0, RENDER_QUANTUM));
    assert_eq!(blocks[0].p0, 0.0);
}

#[test]
fn empty_tempo_map_yields_one_block() {
    let mut transport = Transport::new(48000.0, 120.0);
    transport.play();
    let tempo = EventCollection::new();
    let blocks = collect(&mut transport, Some(&tempo));
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].bpm, 120.0);
}

#[test]
fn stopped_transport_emits_nothing() {
    let mut transport = Transport::new(48000.0, 120.0);
    let blocks = collect(&mut transport, None);
    assert!(blocks.is_empty());
}

#[test]
fn tempo_change_at_grid_splits_the_quantum() {
    // bpm map: 120 from bar 0, stepping to 140 at the grid (pulse 80).
    let mut tempo = EventCollection::new();
    tempo.add(ValueEvent::new(0.0, 0, 120.0, Interpolation::None));
    tempo.add(ValueEvent::new(TEMPO_CHANGE_GRID, 0, 140.0, Interpolation::None));

    // start just before the grid so the quantum straddles pulse 80.
    let mut transport = Transport::new(48000.0, 120.0);
    transport.seek(TEMPO_CHANGE_GRID - 2.0);
    transport.play();
    let blocks = collect(&mut transport, Some(&tempo));

    assert_eq!(blocks.len(), 2, "the quantum splits at the tempo-change grid");
    assert_eq!(blocks[0].bpm, 120.0, "first sub-block keeps the old bpm");
    assert_eq!(blocks[1].bpm, 140.0, "second sub-block uses the new bpm");
    assert_eq!(blocks[0].p1, TEMPO_CHANGE_GRID, "split happens at the grid pulse");
    assert_eq!(blocks[1].p0, TEMPO_CHANGE_GRID);
    assert_eq!(blocks[0].s0, 0);
    assert_eq!(blocks[1].s1, RENDER_QUANTUM, "the two sub-blocks cover the whole quantum");
    assert_eq!(blocks[0].s1, blocks[1].s0, "sample ranges are contiguous");
    assert_eq!(transport.bpm(), 140.0, "live bpm advanced to the new tempo");
}

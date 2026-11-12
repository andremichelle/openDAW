//! The Sampler's observed tables (zones, groups, modulation slots) and the decisions made from them at a note:
//! which zones answer a key and velocity, where a zone stands among its round robins, and how far a crossfade
//! has taken it down. Everything here only reads tables, so it is plain to test.

use abi::{Table, TableColumn};

// WASM CONTRACT: the field keys of `SamplerZoneBox`, `SamplerGroupBox` and `SamplerModulationBox`.
pub const ZONE_COLUMNS: [TableColumn; 24] = [
    TableColumn::sample(2), TableColumn::target(3, 3), TableColumn::value(5),
    TableColumn::value(10), TableColumn::value(11), TableColumn::value(12), TableColumn::value(13),
    TableColumn::value(20), TableColumn::value(21), TableColumn::value(22),
    TableColumn::value(30), TableColumn::value(31), TableColumn::value(32),
    TableColumn::value(40), TableColumn::value(41), TableColumn::value(42), TableColumn::value(43), TableColumn::value(44),
    TableColumn::value(50), TableColumn::value(51), TableColumn::value(52), TableColumn::value(53), TableColumn::value(54),
    TableColumn::value(55)
];
pub const GROUP_COLUMNS: [TableColumn; 4] =
    [TableColumn::value(3), TableColumn::value(10), TableColumn::value(11), TableColumn::value(12)];
pub const MODULATION_COLUMNS: [TableColumn; 3] = [TableColumn::value(10), TableColumn::value(11), TableColumn::value(12)];

pub const ROBIN_OFF: i32 = 0;
pub const ROBIN_RANDOM: i32 = 2;
pub const TRIGGER_ATTACK: i32 = 0;
pub const TRIGGER_RELEASE: i32 = 1;
pub const LOOP_OFF: i32 = 0;
pub const LOOP_ON: i32 = 1;

/// One row of the zone table, copied out so a voice can keep it while the table moves on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Zone {
    pub sample: Option<u32>,
    pub group: Option<u32>, // the `index` of the group the zone belongs to
    pub enabled: bool,
    pub key_low: i32,
    pub key_high: i32,
    pub key_fade: i32,
    pub root_key: i32,
    pub velocity_low: i32,
    pub velocity_high: i32,
    pub velocity_fade: i32,
    pub transpose: i32,
    pub tune: f32, // cents
    pub key_track: f32,
    pub gain: f32, // decibel
    pub panning: f32,
    pub sequence: i32,
    pub reverse: bool,
    pub one_shot: bool,
    pub sample_start: i32,
    pub sample_end: i32,
    pub loop_mode: i32,
    pub loop_start: i32,
    pub loop_end: i32,
    pub loop_fade: f32 // seconds
}

impl Zone {
    pub fn read(table: &Table, row: usize) -> Self {
        Self {
            sample: table.link(row, 0),
            group: table.link(row, 1),
            enabled: table.bool(row, 2),
            key_low: table.int(row, 3),
            key_high: table.int(row, 4),
            key_fade: table.int(row, 5),
            root_key: table.int(row, 6),
            velocity_low: table.int(row, 7),
            velocity_high: table.int(row, 8),
            velocity_fade: table.int(row, 9),
            transpose: table.int(row, 10),
            tune: table.float(row, 11),
            key_track: table.float(row, 12),
            gain: table.float(row, 13),
            panning: table.float(row, 14),
            sequence: table.int(row, 15),
            reverse: table.bool(row, 16),
            one_shot: table.bool(row, 17),
            sample_start: table.int(row, 18),
            sample_end: table.int(row, 19),
            loop_mode: table.int(row, 20),
            loop_start: table.int(row, 21),
            loop_end: table.int(row, 22),
            loop_fade: table.float(row, 23)
        }
    }

    pub fn accepts(&self, key: i32, velocity: i32) -> bool {
        self.enabled && key >= self.key_low && key <= self.key_high && velocity >= self.velocity_low && velocity <= self.velocity_high
    }

    // on the same keys and velocities of the same group: the two are round robins of each other
    pub fn shares_range(&self, other: &Zone) -> bool {
        self.enabled && other.enabled && self.group == other.group && self.key_low == other.key_low && self.key_high == other.key_high
            && self.velocity_low == other.velocity_low && self.velocity_high == other.velocity_high
    }
}

/// What a zone takes from its group. A zone without a group plays on the attack, layered, unchoked.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Group {
    pub round_robin: i32,
    pub choke: i32,
    pub trigger: i32
}

impl Group {
    pub const NONE: Group = Group {round_robin: ROBIN_OFF, choke: 0, trigger: TRIGGER_ATTACK};

    pub fn find(groups: &Table, index: Option<u32>) -> Self {
        let Some(index) = index else { return Self::NONE };
        (0..groups.rows()).find(|row| groups.word(*row, 0) == index).map_or(Self::NONE, |row| Self {
            round_robin: groups.int(row, 1),
            choke: groups.int(row, 2),
            trigger: groups.int(row, 3)
        })
    }
}

/// Where the zone at `row` stands among its round robins and how many there are, ordered by `sequence` and,
/// for equal sequences, by row.
pub fn robin_position(zones: &Table, row: usize, zone: &Zone) -> (u32, u32) {
    let (mut rank, mut size) = (0, 0);
    for other_row in 0..zones.rows() {
        let other = Zone::read(zones, other_row);
        if !zone.shares_range(&other) {continue}
        size += 1;
        if (other.sequence, other_row) < (zone.sequence, row) {rank += 1;}
    }
    (rank, size)
}

/// The round robin a note plays. `counter` is what the key remembers: the notes played so far when cycling,
/// the last pick when random. A random pick never repeats the last one while there is a choice.
pub fn robin_pick(round_robin: i32, size: u32, counter: u32, random: u32) -> u32 {
    if size <= 1 {
        0
    } else if round_robin == ROBIN_RANDOM {
        (counter % size + 1 + random % (size - 1)) % size
    } else {
        counter % size
    }
}

/// The gain a crossfade leaves of the zone at this key and velocity, equal power. An edge fades only where
/// another zone of the same group overlaps it, so the outer edges of an instrument stay at full level.
pub fn fade_gain(zones: &Table, row: usize, zone: &Zone, key: i32, velocity: i32) -> f32 {
    let mut gain = 1.0f32;
    let mut edge = |distance: i32, fade: i32, overlapped: &dyn Fn(&Zone) -> bool| {
        if fade <= 0 || distance >= fade {return}
        let covered = (0..zones.rows()).filter(|other_row| *other_row != row).any(|other_row| {
            let other = Zone::read(zones, other_row);
            other.enabled && other.group == zone.group && !zone.shares_range(&other) && overlapped(&other)
        });
        if covered {gain *= libm::sqrtf((distance + 1) as f32 / (fade + 1) as f32);}
    };
    let beside = |other: &Zone| other.velocity_low <= zone.velocity_high && other.velocity_high >= zone.velocity_low;
    let stacked = |other: &Zone| other.key_low <= zone.key_high && other.key_high >= zone.key_low;
    edge(key - zone.key_low, zone.key_fade, &|other| beside(other) && other.key_low < zone.key_low && other.key_high >= zone.key_low);
    edge(zone.key_high - key, zone.key_fade, &|other| beside(other) && other.key_high > zone.key_high && other.key_low <= zone.key_high);
    edge(velocity - zone.velocity_low, zone.velocity_fade,
        &|other| stacked(other) && other.velocity_low < zone.velocity_low && other.velocity_high >= zone.velocity_low);
    edge(zone.velocity_high - velocity, zone.velocity_fade,
        &|other| stacked(other) && other.velocity_high > zone.velocity_high && other.velocity_low <= zone.velocity_high);
    gain
}

/// MIDI velocity 1 to 127 of a note's unit velocity.
pub fn midi_velocity(velocity: f32) -> i32 {
    (libm::roundf(velocity * 127.0) as i32).clamp(1, 127)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use abi::TABLE_NONE;

    pub(crate) fn zone() -> Zone {
        Zone {
            sample: Some(1), group: None, enabled: true, key_low: 0, key_high: 127, key_fade: 0, root_key: 60, velocity_low: 1,
            velocity_high: 127, velocity_fade: 0, transpose: 0, tune: 0.0, key_track: 1.0, gain: 0.0, panning: 0.0,
            sequence: 1, reverse: false, one_shot: false, sample_start: 0, sample_end: i32::MAX, loop_mode: LOOP_OFF,
            loop_start: 0, loop_end: i32::MAX, loop_fade: 0.0
        }
    }

    pub(crate) fn words(zone: &Zone) -> [u32; 24] {
        [
            zone.sample.unwrap_or(TABLE_NONE), zone.group.unwrap_or(TABLE_NONE), zone.enabled as u32,
            zone.key_low as u32, zone.key_high as u32, zone.key_fade as u32, zone.root_key as u32,
            zone.velocity_low as u32, zone.velocity_high as u32, zone.velocity_fade as u32,
            zone.transpose as u32, zone.tune.to_bits(), zone.key_track.to_bits(),
            zone.gain.to_bits(), zone.panning.to_bits(), zone.sequence as u32, zone.reverse as u32, zone.one_shot as u32,
            zone.sample_start as u32, zone.sample_end as u32, zone.loop_mode as u32, zone.loop_start as u32,
            zone.loop_end as u32, zone.loop_fade.to_bits()
        ]
    }

    pub(crate) fn table(zones: &[Zone]) -> Table {
        let flat: Vec<u32> = zones.iter().flat_map(words).collect();
        Table::from_words(Box::leak(flat.into_boxed_slice()), ZONE_COLUMNS.len() as u32)
    }

    fn groups(rows: &[[i32; 4]]) -> Table {
        let flat: Vec<u32> = rows.iter().flat_map(|row| row.map(|value| value as u32)).collect();
        Table::from_words(Box::leak(flat.into_boxed_slice()), GROUP_COLUMNS.len() as u32)
    }

    fn ranged(group: Option<u32>, keys: (i32, i32), velocities: (i32, i32)) -> Zone {
        Zone {group, key_low: keys.0, key_high: keys.1, velocity_low: velocities.0, velocity_high: velocities.1, ..zone()}
    }

    #[test]
    fn a_row_reads_back_every_field() {
        let written = Zone {
            sample: Some(77), group: Some(3), enabled: true, key_low: 12, key_high: 24, key_fade: 2, root_key: 18, velocity_low: 5,
            velocity_high: 99, velocity_fade: 7, transpose: -12, tune: -37.5, key_track: 0.25, gain: -6.5, panning: -0.75,
            sequence: 4, reverse: true, one_shot: true, sample_start: 1_000, sample_end: 30_000_000, loop_mode: 2,
            loop_start: 20_000_001, loop_end: 29_999_999, loop_fade: 0.125
        };
        assert_eq!(Zone::read(&table(&[zone(), written]), 1), written);
    }

    #[test]
    fn a_disabled_zone_answers_nothing_and_is_nobodys_round_robin() {
        let off = Zone {enabled: false, ..ranged(Some(1), (40, 50), (20, 90))};
        let on = ranged(Some(1), (40, 50), (20, 90));
        assert!(!off.accepts(45, 55));
        assert!(!off.shares_range(&on) && !on.shares_range(&off));
        let zones = [on, off, on];
        assert_eq!(robin_position(&table(&zones), 2, &zones[2]), (1, 2), "the stack counts only what is on the map");
    }

    #[test]
    fn a_disabled_zone_fades_nobody() {
        let zones = [Zone {key_fade: 3, ..ranged(None, (40, 50), (1, 127))}, Zone {enabled: false, ..ranged(None, (30, 42), (1, 127))}];
        assert_eq!(fade_gain(&table(&zones), 0, &zones[0], 40, 64), 1.0);
    }

    #[test]
    fn unbound_pointers_read_as_none() {
        let read = Zone::read(&table(&[Zone {sample: None, group: None, ..zone()}]), 0);
        assert_eq!((read.sample, read.group), (None, None));
    }

    #[test]
    fn the_columns_match_the_fields_a_row_reads() {
        assert_eq!(ZONE_COLUMNS.len(), words(&zone()).len());
        assert_eq!(ZONE_COLUMNS[0], TableColumn::sample(2));
        assert_eq!(ZONE_COLUMNS[1], TableColumn::target(3, 3), "the group pointer delivers the group's index");
        let keys: Vec<u16> = ZONE_COLUMNS[2..].iter().map(|column| column.key).collect();
        assert_eq!(keys, [5, 10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 41, 42, 43, 44, 50, 51, 52, 53, 54, 55]);
    }

    #[test]
    fn a_zone_accepts_its_edges_and_nothing_beyond() {
        let zone = ranged(None, (40, 50), (20, 90));
        for (key, velocity, accepted) in [
            (40, 20, true), (50, 90, true), (45, 55, true),
            (39, 55, false), (51, 55, false), (45, 19, false), (45, 91, false)
        ] {
            assert_eq!(zone.accepts(key, velocity), accepted, "key {key} velocity {velocity}");
        }
    }

    #[test]
    fn a_one_key_one_velocity_zone_accepts_exactly_that() {
        let zone = ranged(None, (60, 60), (64, 64));
        assert!(zone.accepts(60, 64));
        assert!(!zone.accepts(60, 63) && !zone.accepts(61, 64));
    }

    #[test]
    fn round_robins_share_group_and_all_four_edges() {
        let base = ranged(Some(1), (40, 50), (20, 90));
        assert!(base.shares_range(&ranged(Some(1), (40, 50), (20, 90))));
        for other in [
            ranged(Some(2), (40, 50), (20, 90)), ranged(None, (40, 50), (20, 90)), ranged(Some(1), (41, 50), (20, 90)),
            ranged(Some(1), (40, 51), (20, 90)), ranged(Some(1), (40, 50), (21, 90)), ranged(Some(1), (40, 50), (20, 91))
        ] {
            assert!(!base.shares_range(&other));
        }
    }

    #[test]
    fn a_group_is_found_by_its_index_not_its_row() {
        let table = groups(&[[5, 1, 0, 0], [2, 2, 9, 1]]);
        assert_eq!(Group::find(&table, Some(2)), Group {round_robin: 2, choke: 9, trigger: 1});
        assert_eq!(Group::find(&table, Some(5)), Group {round_robin: 1, choke: 0, trigger: 0});
    }

    #[test]
    fn a_missing_group_plays_layered_on_the_attack() {
        let table = groups(&[[5, 1, 3, 1]]);
        assert_eq!(Group::find(&table, None), Group::NONE);
        assert_eq!(Group::find(&table, Some(6)), Group::NONE, "an index no group has");
        assert_eq!(Group::find(&Table::empty(), Some(5)), Group::NONE);
    }

    #[test]
    fn round_robins_are_ranked_by_sequence_then_row() {
        let stack = |sequence: i32| Zone {sequence, ..ranged(Some(1), (36, 36), (1, 127))};
        let zones = [stack(3), ranged(Some(1), (38, 38), (1, 127)), stack(1), stack(3), ranged(Some(2), (36, 36), (1, 127))];
        let table = table(&zones);
        assert_eq!(robin_position(&table, 2, &zones[2]), (0, 3), "sequence 1 goes first");
        assert_eq!(robin_position(&table, 0, &zones[0]), (1, 3), "of two with sequence 3 the earlier row");
        assert_eq!(robin_position(&table, 3, &zones[3]), (2, 3));
        assert_eq!(robin_position(&table, 1, &zones[1]), (0, 1), "another key is its own stack");
        assert_eq!(robin_position(&table, 4, &zones[4]), (0, 1), "another group is its own stack");
    }

    #[test]
    fn cycling_walks_the_stack_and_wraps() {
        let picks: Vec<u32> = (0..7).map(|counter| robin_pick(1, 3, counter, 12_345)).collect();
        assert_eq!(picks, [0, 1, 2, 0, 1, 2, 0]);
    }

    #[test]
    fn a_stack_of_one_always_plays() {
        for round_robin in [ROBIN_OFF, 1, ROBIN_RANDOM] {
            assert_eq!(robin_pick(round_robin, 1, 9, 9), 0);
            assert_eq!(robin_pick(round_robin, 0, 9, 9), 0);
        }
    }

    #[test]
    fn random_never_repeats_the_last_pick() {
        for size in 2..9u32 {
            for last in 0..size {
                for random in 0..200u32 {
                    let pick = robin_pick(ROBIN_RANDOM, size, last, random);
                    assert!(pick < size);
                    assert_ne!(pick, last, "size {size} last {last} random {random}");
                }
            }
        }
    }

    #[test]
    fn random_reaches_every_other_member() {
        let mut seen = [false; 5];
        (0..50u32).for_each(|random| seen[robin_pick(ROBIN_RANDOM, 5, 2, random) as usize] = true);
        assert_eq!(seen, [true, true, false, true, true]);
    }

    #[test]
    fn two_random_members_alternate() {
        assert_eq!(robin_pick(ROBIN_RANDOM, 2, 0, 7), 1);
        assert_eq!(robin_pick(ROBIN_RANDOM, 2, 1, 7), 0);
    }

    #[test]
    fn no_fade_is_full_level_everywhere() {
        let zones = [ranged(None, (40, 50), (1, 127)), ranged(None, (48, 60), (1, 127))];
        let table = table(&zones);
        for key in 40..=50 {
            assert_eq!(fade_gain(&table, 0, &zones[0], key, 64), 1.0);
        }
    }

    #[test]
    fn an_edge_nothing_overlaps_does_not_fade() {
        let zones = [Zone {key_fade: 4, velocity_fade: 20, ..ranged(None, (40, 50), (10, 100))}];
        let table = table(&zones);
        for (key, velocity) in [(40, 64), (50, 64), (45, 10), (45, 100)] {
            assert_eq!(fade_gain(&table, 0, &zones[0], key, velocity), 1.0, "key {key} velocity {velocity}");
        }
    }

    #[test]
    fn an_overlapped_key_edge_fades_in_equal_power() {
        let zones = [Zone {key_fade: 3, ..ranged(None, (40, 50), (1, 127))}, ranged(None, (30, 42), (1, 127))];
        let table = table(&zones);
        let gains: Vec<f32> = (40..=44).map(|key| fade_gain(&table, 0, &zones[0], key, 64)).collect();
        assert_eq!(gains, [libm::sqrtf(0.25), libm::sqrtf(0.5), libm::sqrtf(0.75), 1.0, 1.0]);
        assert_eq!(fade_gain(&table, 0, &zones[0], 50, 64), 1.0, "the high edge has no neighbour");
    }

    #[test]
    fn the_high_key_edge_fades_towards_a_higher_neighbour() {
        let zones = [Zone {key_fade: 1, ..ranged(None, (40, 50), (1, 127))}, ranged(None, (50, 60), (1, 127))];
        let table = table(&zones);
        assert_eq!(fade_gain(&table, 0, &zones[0], 50, 64), libm::sqrtf(0.5));
        assert_eq!(fade_gain(&table, 0, &zones[0], 49, 64), 1.0);
        assert_eq!(fade_gain(&table, 0, &zones[0], 40, 64), 1.0);
    }

    #[test]
    fn velocity_edges_fade_towards_layers_on_the_same_keys() {
        let zones = [
            Zone {velocity_fade: 1, ..ranged(None, (40, 50), (40, 80))},
            ranged(None, (40, 50), (1, 45)), ranged(None, (40, 50), (76, 127))
        ];
        let table = table(&zones);
        assert_eq!(fade_gain(&table, 0, &zones[0], 45, 40), libm::sqrtf(0.5));
        assert_eq!(fade_gain(&table, 0, &zones[0], 45, 80), libm::sqrtf(0.5));
        assert_eq!(fade_gain(&table, 0, &zones[0], 45, 60), 1.0);
    }

    #[test]
    fn a_corner_fades_on_both_axes() {
        let zones = [
            Zone {key_fade: 1, velocity_fade: 1, ..ranged(None, (40, 50), (40, 80))},
            ranged(None, (30, 40), (40, 80)), ranged(None, (40, 50), (1, 40))
        ];
        let table = table(&zones);
        assert!((fade_gain(&table, 0, &zones[0], 40, 40) - 0.5).abs() < 1.0e-6);
    }

    #[test]
    fn neighbours_that_do_not_count() {
        let fading = Zone {key_fade: 3, ..ranged(Some(1), (40, 50), (40, 80))};
        for (other, reason) in [
            (ranged(Some(2), (30, 42), (40, 80)), "another group"),
            (ranged(Some(1), (30, 42), (81, 127)), "other velocities"),
            (ranged(Some(1), (30, 39), (40, 80)), "it only touches"),
            (ranged(Some(1), (40, 50), (40, 80)), "its own round robin"),
            (ranged(Some(1), (41, 45), (40, 80)), "it lies inside")
        ] {
            let zones = [fading, other];
            assert_eq!(fade_gain(&table(&zones), 0, &zones[0], 40, 64), 1.0, "{reason}");
        }
    }

    #[test]
    fn a_fade_longer_than_the_zone_never_exceeds_full_level() {
        let zones = [Zone {key_fade: 127, ..ranged(None, (40, 42), (1, 127))}, ranged(None, (30, 40), (1, 127))];
        let table = table(&zones);
        for key in 40..=42 {
            let gain = fade_gain(&table, 0, &zones[0], key, 64);
            assert!(gain > 0.0 && gain < 1.0);
        }
    }

    #[test]
    fn unit_velocity_becomes_midi_one_to_127() {
        assert_eq!(midi_velocity(1.0), 127);
        assert_eq!(midi_velocity(0.0), 1, "a note never has velocity 0");
        assert_eq!(midi_velocity(0.5), 64);
        assert_eq!(midi_velocity(2.0), 127);
        assert_eq!(midi_velocity(-1.0), 1);
        assert_eq!(midi_velocity(1.0 / 127.0), 1);
    }
}

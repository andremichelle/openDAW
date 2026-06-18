//! Which side of a render a wiring / observer callback runs on (`ProcessPhase` in TS). Wiring is
//! (re)built in `Before`, never mid-render; cleanup in `After`.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessPhase {
    Before,
    After
}

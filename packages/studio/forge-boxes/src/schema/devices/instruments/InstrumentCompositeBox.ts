import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"

// A generic composite instrument: it hosts a collection of CELLS instead of being a single leaf DSP, and the
// engine sums them into one output (see the composite mechanism in the wasm engine). Each cell (CompositeCellBox)
// wraps ONE instrument plus its own midi / audio fx chains, so an instrument and its effects live inside the
// composite with NO plugin changes (they attach to the cell by their normal `host` pointers, as they would to an
// audio unit). Unlike Playfield (whose children route by a per-slot note index), a composite cell carries no
// index, so every child receives the full note stream and plays it, instruments reacting to the same notes.
export const CompositeDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("CompositeDeviceBox", "notes", {
    10: {type: "field", name: "cells", pointerRules: {accepts: [Pointers.CompositeCell], mandatory: false}}
})

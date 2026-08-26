import {describe, expect, it} from "vitest"
import {isDefined} from "@opendaw/lib-std"
import {PPQN, ppqn} from "@opendaw/lib-dsp"

// #309: after a double click creates a node and the gesture continues into a drag, the node must flip to the next
// snap position when the cursor passes the middle of a grid cell, exactly like dragging an existing node.
// ValueMoveModifier keeps (pointerPulse - reference.position) as a grab offset for the whole drag, so ValueEditor
// has to anchor it on the CREATED node. Anchoring on the raw click leaks the double-click's snap residual into that
// offset and displaces every boundary by it.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const Grid: ppqn = PPQN.fromSignature(1, 4)

// Snapping pulls studio-core's barrel, which defines EngineWorklet extends AudioWorkletNode at import time.
const createSnapping = async () => {
    const {TimelineRange} = await import("@opendaw/studio-core")
    const {Snapping} = await import("@/ui/timeline/Snapping.ts")
    const range = new TimelineRange({padding: 0})
    range.maxUnits = PPQN.fromSignature(64, 4)
    range.width = 1024
    range.showAll()
    const snapping = new Snapping(range)
    snapping.index = 3 // 1/4
    expect(snapping.value(0)).toBe(Grid)
    return {range, snapping}
}

// Sweeps the cursor across one grid cell and returns the fraction of it that keeps the node on the cell's left edge.
type Sweep = Readonly<{ pointerPulse: ppqn, reference: ppqn, offset: ppqn }>
const leftShareOfCell = async ({pointerPulse, reference, offset}: Sweep): Promise<number> => {
    const {range, snapping} = await createSnapping()
    const steps = 2000
    const positions = Array.from({length: steps}, (_ignored, step) => {
        const cursorPulse = reference + (step + 0.5) / steps * Grid
        return reference + snapping.computeDelta(pointerPulse, range.unitToX(cursorPulse + offset), reference)
    })
    expect(new Set(positions)).toEqual(new Set([reference, reference + Grid]))
    return positions.filter(position => position === reference).length / steps
}

// The double click places the node at the snapped pulse, which is what the fixed call site hands the modifier.
const createNodeByDoubleClick = async (clickPulse: ppqn, offset: ppqn): Promise<Sweep> => {
    const {snapping} = await createSnapping()
    const reference = snapping.round(clickPulse + offset) - offset
    return {pointerPulse: reference + offset, reference, offset}
}

describe("automation node snapping while dragging (#309)", () => {
    it("dragging an existing node flips at the middle of the cell", async () => {
        const reference: ppqn = Grid * 4
        expect(await leftShareOfCell({pointerPulse: reference, reference, offset: 0})).toBeCloseTo(0.5, 2)
    })

    it("dragging a just-created node flips at the middle of the cell, wherever the click landed", async () => {
        for (const fraction of [-0.45, -0.25, -0.05, 0.0, 0.05, 0.25, 0.45]) {
            const sweep = await createNodeByDoubleClick(Grid * 4 + Grid * fraction, 0)
            expect(await leftShareOfCell(sweep), `click at ${fraction} of the cell`).toBeCloseTo(0.5, 2)
        }
    })

    it("the same, inside a region that does not start at zero", async () => {
        const offset: ppqn = Grid * 3
        for (const fraction of [-0.4, 0.0, 0.4]) {
            const sweep = await createNodeByDoubleClick(Grid * 4 + Grid * fraction, offset)
            expect(await leftShareOfCell(sweep), `click at ${fraction} of the cell`).toBeCloseTo(0.5, 2)
        }
    })

    it("anchoring the drag on the raw click instead reproduces the reported 10/90 split", async () => {
        const clickPulse = Grid * 4 - Grid * 0.4
        const {reference} = await createNodeByDoubleClick(clickPulse, 0)
        expect(await leftShareOfCell({pointerPulse: clickPulse, reference, offset: 0})).toBeCloseTo(0.1, 2)
    })
})

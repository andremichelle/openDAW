import {
    BoxIO,
    BoxVisitor,
    GrooveFunctionBox,
    GrooveOffsetBox,
    GrooveRandomBox,
    GrooveShuffleBox,
    GrooveStackBox,
    GrooveStackEntryBox,
    AudioUnitBox,
    CubedDeviceBox,
    TrackBox,
    NoteClipBox,
    NoteRegionBox,
    RootBox,
    ValueClipBox,
    ValueRegionBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {Box, PointerField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {ByteArrayInput, int, isDefined, isInstanceOf, Nullable, Option, panic, Strings, UUID} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {GrooveAdapter, GrooveBox, GrooveKind, isGrooveBox} from "./GrooveBoxAdapter"
import {GrooveFunctionType} from "./GrooveFunctionBoxAdapter"

// Every caller is inside an `editing.modify`, so nothing here opens a transaction
export namespace Grooves {
    export type Kind = {
        readonly kind: GrooveKind
        readonly label: string
    }

    export const Kinds: ReadonlyArray<Kind> = [
        {kind: "shuffle", label: "Shuffle"},
        {kind: "power", label: "Power"},
        {kind: "s-curve", label: "S-Curve"},
        {kind: "random", label: "Random"},
        {kind: "offset", label: "Offset"},
        {kind: "stack", label: "Stack"}
    ]

    export const labelOf = (kind: GrooveKind): string =>
        Kinds.find(entry => entry.kind === kind)?.label ?? panic(`Unknown groove kind ${kind}`)

    const KindVisitor: BoxVisitor<GrooveKind> = {
        visitGrooveShuffleBox: (): GrooveKind => "shuffle",
        visitGrooveFunctionBox: (box: GrooveFunctionBox): GrooveKind =>
            box.function.getValue() === GrooveFunctionType.SCurve ? "s-curve" : "power",
        visitGrooveRandomBox: (): GrooveKind => "random",
        visitGrooveOffsetBox: (): GrooveKind => "offset",
        visitGrooveStackBox: (): GrooveKind => "stack"
    }

    export const kindOf = (box: GrooveBox): GrooveKind => box.accept(KindVisitor) ?? panic(`${box.name} is no groove`)

    export const asGrooveBox = (box: Box): GrooveBox => box.accept<BoxVisitor<GrooveBox>>({
        visitGrooveShuffleBox: (box: GrooveShuffleBox) => box,
        visitGrooveFunctionBox: (box: GrooveFunctionBox) => box,
        visitGrooveRandomBox: (box: GrooveRandomBox) => box,
        visitGrooveOffsetBox: (box: GrooveOffsetBox) => box,
        visitGrooveStackBox: (box: GrooveStackBox) => box
    }) ?? panic(`${box.name} is no groove`)

    export const isGlobal = (context: BoxAdaptersContext, groove: GrooveBox): boolean =>
        context.rootBoxAdapter.box.groove.targetAddress
            .mapOr(address => UUID.equals(address.uuid, groove.address.uuid), false)

    export const globalGroove = (context: BoxAdaptersContext): GrooveBox =>
        asGrooveBox(context.rootBoxAdapter.box.groove.targetVertex.unwrap("No global groove").box)

    export const users = (groove: GrooveBox): ReadonlyArray<PointerField<Pointers.Groove>> =>
        groove.pointerHub.filter(Pointers.Groove) as ReadonlyArray<PointerField<Pointers.Groove>>

    export const targets = (groove: GrooveBox): ReadonlyArray<PointerField<Pointers.Groove>> =>
        users(groove).filter(pointer => !isInstanceOf(pointer.box, RootBox))

    export const create = (context: BoxAdaptersContext, kind: GrooveKind, label?: string): GrooveBox => {
        const {boxGraph} = context
        const uuid = UUID.generate()
        const box: GrooveBox = kind === "shuffle" ? GrooveShuffleBox.create(boxGraph, uuid)
            : kind === "power" ? GrooveFunctionBox.create(boxGraph, uuid,
                    box => box.function.setValue(GrooveFunctionType.Power))
                : kind === "s-curve" ? GrooveFunctionBox.create(boxGraph, uuid,
                        box => box.function.setValue(GrooveFunctionType.SCurve))
                    : kind === "random" ? GrooveRandomBox.create(boxGraph, uuid)
                        : kind === "offset" ? GrooveOffsetBox.create(boxGraph, uuid)
                            : GrooveStackBox.create(boxGraph, uuid)
        attach(context, box, label ?? labelOf(kind))
        return box
    }

    export const replace = (context: BoxAdaptersContext, groove: GrooveBox, kind: GrooveKind): GrooveBox => {
        if (kindOf(groove) === kind) {return groove}
        if (isInstanceOf(groove, GrooveFunctionBox) && (kind === "power" || kind === "s-curve")) {
            groove.function.setValue(kind === "s-curve" ? GrooveFunctionType.SCurve : GrooveFunctionType.Power)
            return groove
        }
        const replacement = create(context, kind)
        users(groove).slice().forEach(pointer => pointer.refer(replacement))
        const label = groove.label.getValue()
        const index = groove.index.getValue()
        const amount = amountOf(groove)
        const duration = durationOf(groove)
        groove.delete()
        replacement.label.setValue(label)
        replacement.index.setValue(index)
        if (!isInstanceOf(replacement, GrooveStackBox) && !isInstanceOf(replacement, GrooveOffsetBox)) {
            if (isDefined(amount)) {replacement.amount.setValue(amount)}
            if (isDefined(duration)) {replacement.duration.setValue(duration)}
        }
        return replacement
    }

    export const duplicate = (context: BoxAdaptersContext, groove: GrooveBox): GrooveBox => {
        const input = new ByteArrayInput(groove.toArrayBuffer())
        const copy = asGrooveBox(context.boxGraph.createBox(groove.name as keyof BoxIO.TypeMap,
            UUID.generate(), box => box.read(input)))
        copy.collection.defer()
        attach(context, copy, groove.label.getValue())
        if (isInstanceOf(groove, GrooveStackBox) && isInstanceOf(copy, GrooveStackBox)) {
            entriesOf(groove).forEach(entry => entry.groove.targetVertex.ifSome(target =>
                GrooveStackEntryBox.create(context.boxGraph, UUID.generate(), box => {
                    box.stack.refer(copy.entries)
                    box.groove.refer(target.box)
                    box.index.setValue(entry.index.getValue())
                })))
        }
        return copy
    }

    export const makeUnique = (context: BoxAdaptersContext,
                               groove: GrooveBox,
                               user: PointerField<Pointers.Groove>): GrooveBox => {
        const copy = duplicate(context, groove)
        user.refer(copy)
        return copy
    }

    export type TimelineBox = NoteRegionBox | ValueRegionBox | NoteClipBox | ValueClipBox

    export const isTimelineBox = (box: Box): box is TimelineBox =>
        isInstanceOf(box, NoteRegionBox) || isInstanceOf(box, ValueRegionBox)
        || isInstanceOf(box, NoteClipBox) || isInstanceOf(box, ValueClipBox)

    export const pointerOf = (box: Box): Option<PointerField<Pointers.Groove>> =>
        isTimelineBox(box) ? Option.wrap(box.groove) : Option.None

    export type FlattenGroove = "apply" | "keep"

    export const playedAt = (context: BoxAdaptersContext, box: Box, origin: number): Option<(position: number) => number> =>
        pointerOf(box).flatMap(pointer => pointer.targetVertex).map(({box: groove}) => {
            const adapter = adapterOf(context, asGrooveBox(groove))
            return (position: number) => origin + adapter.warp(position - origin)
        })

    export const sharedOf = (boxes: ReadonlyArray<Box>): Option<GrooveBox> => {
        const targets = boxes.map(box => pointerOf(box).flatMap(pointer => pointer.targetVertex).map(vertex => vertex.box))
        const first = targets.at(0)
        if (!isDefined(first) || first.isEmpty()) {return Option.None}
        const groove = first.unwrap()
        return targets.every(target => target.contains(groove)) ? Option.wrap(asGrooveBox(groove)) : Option.None
    }

    export const unitOf = (box: TimelineBox): Option<AudioUnitBox> =>
        (isInstanceOf(box, NoteRegionBox) || isInstanceOf(box, ValueRegionBox) ? box.regions : box.clips).targetVertex
            .flatMap(({box: track}) => isInstanceOf(track, TrackBox) ? track.tracks.targetVertex : Option.None)
            .flatMap(({box: unit}) => isInstanceOf(unit, AudioUnitBox) ? Option.wrap(unit) : Option.None)

    export type DeleteMode = "fallback" | "remove"

    export const deleteAll = (context: BoxAdaptersContext,
                              grooves: ReadonlyArray<GrooveBox>,
                              mode: DeleteMode): void => {
        const doomed = new Set<GrooveBox>(grooves.filter(groove => !isGlobal(context, groove)))
        if (doomed.size === 0) {return}
        const global = globalGroove(context)
        doomed.forEach(groove => users(groove).slice().forEach(pointer => {
            if (mode === "fallback" && !isTimelineBox(pointer.box) && !isInstanceOf(pointer.box, CubedDeviceBox)) {
                if (isInstanceOf(pointer.box, GrooveStackEntryBox)
                    && wouldContain(global, asGrooveBox(pointer.box.stack.targetVertex
                        .unwrap("Entry without stack").box))) {
                    unassign(pointer)
                } else {
                    pointer.refer(global)
                }
            } else {
                unassign(pointer)
            }
        }))
        const remaining = context.rootBoxAdapter.grooves.adapters()
            .filter(adapter => !doomed.has(adapter.box))
            .map(adapter => adapter.box)
        doomed.forEach(groove => groove.delete())
        reindex(remaining)
    }

    // a stack entry without its member is deleted
    export const unassign = (pointer: PointerField<Pointers.Groove>): void => {
        if (isInstanceOf(pointer.box, GrooveStackEntryBox)) {
            const stack = pointer.box.stack.targetVertex.map(vertex => asGrooveBox(vertex.box))
            pointer.box.delete()
            stack.ifSome(stack => {
                if (isInstanceOf(stack, GrooveStackBox)) {reindexEntries(entriesOf(stack))}
            })
        } else {
            pointer.defer()
        }
    }

    export const move = (context: BoxAdaptersContext, grooves: ReadonlyArray<GrooveBox>, target: GrooveBox): void => {
        const moved = new Set<GrooveBox>(grooves)
        if (moved.has(target) || moved.size === 0) {return}
        const ordered = context.rootBoxAdapter.grooves.adapters().map(adapter => adapter.box)
        const stationary = ordered.filter(box => !moved.has(box))
        const insertAt = stationary.indexOf(target)
        if (insertAt < 0) {return}
        const dragged = ordered.filter(box => moved.has(box))
        const before = ordered.indexOf(dragged[0]) < ordered.indexOf(target)
        stationary.splice(before ? insertAt + 1 : insertAt, 0, ...dragged)
        reindex(stationary)
    }

    export const wouldContain = (groove: GrooveBox, stack: GrooveBox, visited: Set<GrooveBox> = new Set()): boolean => {
        if (groove === stack) {return true}
        if (!isInstanceOf(groove, GrooveStackBox) || visited.has(groove)) {return false}
        // a cycle from merged edits in a live room ends here
        visited.add(groove)
        return entriesOf(groove).some(entry => entry.groove.targetVertex
            .mapOr(vertex => wouldContain(asGrooveBox(vertex.box), stack, visited), false))
    }

    export const canAddToStack = (stack: GrooveStackBox, groove: GrooveBox): boolean => !wouldContain(groove, stack)

    export const addToStack = (context: BoxAdaptersContext, stack: GrooveStackBox, groove: GrooveBox): void => {
        if (!canAddToStack(stack, groove)) {return}
        GrooveStackEntryBox.create(context.boxGraph, UUID.generate(), box => {
            box.stack.refer(stack.entries)
            box.groove.refer(groove)
            box.index.setValue(entriesOf(stack).length)
        })
    }

    export const removeFromStack = (entry: GrooveStackEntryBox): void => unassign(entry.groove)

    export const moveInStack = (stack: GrooveStackBox, entry: GrooveStackEntryBox, to: int): void => {
        const entries = entriesOf(stack).slice()
        const from = entries.indexOf(entry)
        if (from < 0 || to < 0 || to >= entries.length || from === to) {return}
        entries.splice(from, 1)
        entries.splice(to, 0, entry)
        reindexEntries(entries)
    }

    export const entriesOf = (stack: GrooveStackBox): ReadonlyArray<GrooveStackEntryBox> =>
        stack.entries.pointerHub.incoming()
            .map(pointer => pointer.box)
            .filter((box): box is GrooveStackEntryBox => isInstanceOf(box, GrooveStackEntryBox) && box.isAttached())
            .sort((left, right) => left.index.getValue() - right.index.getValue())

    export type User =
        | { type: "zeitgeist", box: ZeitgeistDeviceBox }
        | { type: "stack", box: GrooveStackBox, entry: GrooveStackEntryBox }
        | { type: "project", box: RootBox }
        | { type: "timeline", box: TimelineBox }
        | { type: "other", box: Box }

    export const userOf = (pointer: PointerField<Pointers.Groove>): User => {
        const box = pointer.box
        if (isInstanceOf(box, ZeitgeistDeviceBox)) {return {type: "zeitgeist", box}}
        if (isInstanceOf(box, RootBox)) {return {type: "project", box}}
        if (isTimelineBox(box)) {return {type: "timeline", box}}
        if (isInstanceOf(box, GrooveStackEntryBox)) {
            const stack = box.stack.targetVertex.map(vertex => vertex.box)
            if (stack.nonEmpty() && isInstanceOf(stack.unwrap(), GrooveStackBox)) {
                return {type: "stack", box: stack.unwrap() as GrooveStackBox, entry: box}
            }
        }
        return {type: "other", box}
    }

    export const adapterOf = (context: BoxAdaptersContext, groove: GrooveBox): GrooveAdapter =>
        context.boxAdapters.adapterFor(groove, GrooveAdapter.checkType)

    const amountOf = (groove: GrooveBox): Nullable<number> =>
        isInstanceOf(groove, GrooveStackBox) || isInstanceOf(groove, GrooveOffsetBox) ? null : groove.amount.getValue()

    const durationOf = (groove: GrooveBox): Nullable<number> =>
        isInstanceOf(groove, GrooveStackBox) || isInstanceOf(groove, GrooveOffsetBox) ? null : groove.duration.getValue()

    const reindex = (grooves: ReadonlyArray<GrooveBox>): void =>
        grooves.forEach((groove, index) => groove.index.setValue(index))

    const reindexEntries = (entries: ReadonlyArray<GrooveStackEntryBox>): void =>
        entries.forEach((entry, index) => entry.index.setValue(index))

    const listed = (context: BoxAdaptersContext): ReadonlyArray<GrooveBox> =>
        context.rootBoxAdapter.box.grooves.pointerHub.incoming().map(pointer => asGrooveBox(pointer.box))

    const attach = (context: BoxAdaptersContext, box: GrooveBox, label: string): void => {
        const existing = listed(context)
        box.label.setValue(Strings.getUniqueName(existing.map(groove => groove.label.getValue()), label))
        box.index.setValue(existing.length)
        box.collection.refer(context.rootBoxAdapter.box.grooves)
    }
}

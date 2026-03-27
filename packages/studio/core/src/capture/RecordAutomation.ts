import {Option, quantizeCeil, quantizeFloor, SortedSet, Terminable, unitValue, UUID} from "@opendaw/lib-std"
import {Interpolation, ppqn, PPQN} from "@opendaw/lib-dsp"
import {Address} from "@opendaw/lib-box"
import {TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {
    AutomatableParameterFieldAdapter,
    ColorCodes,
    InterpolationFieldAdapter,
    ParameterFieldAdapters,
    ParameterWriteEvent,
    TrackBoxAdapter,
    TrackType,
    ValueEventCollectionBoxAdapter
} from "@opendaw/studio-adapters"
import {Project} from "../project"
import {RegionClipResolver} from "../ui"

export namespace RecordAutomation {
    type RecordingState = {
        adapter: AutomatableParameterFieldAdapter
        trackBoxAdapter: TrackBoxAdapter
        regionBox: ValueRegionBox
        collectionBox: ValueEventCollectionBox
        startPosition: ppqn
        floating: boolean
        lastValue: unitValue
        lastRelativePosition: ppqn
        lastEventBox: ValueEventBox
    }

    const Epsilon = 0.01

    type RecorderContext = {
        project: Project
        parameterFieldAdapters: ParameterFieldAdapters
    }

    const findOrCreateTrack = (
        {project, parameterFieldAdapters}: RecorderContext,
        adapter: AutomatableParameterFieldAdapter
    ): Option<TrackBoxAdapter> => {
        const tracksOpt = parameterFieldAdapters.getTracks(adapter.address)
        if (tracksOpt.isEmpty()) {
            console.warn(`Cannot record automation: no tracks registered for '${adapter.name}' (${adapter.address})`)
            return Option.None
        }
        const tracks = tracksOpt.unwrap()
        const existing = tracks.controls(adapter.field)
        if (existing.nonEmpty()) {return Option.wrap(existing.unwrap())}
        const trackBox = TrackBox.create(project.boxGraph, UUID.generate(), box => {
            box.index.setValue(tracks.collection.getMinFreeIndex())
            box.type.setValue(TrackType.Value)
            box.tracks.refer(tracks.audioUnitBox.tracks)
            box.target.refer(adapter.field)
        })
        return Option.wrap(project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter))
    }

    const createRegion = (
        {project}: RecorderContext,
        trackBoxAdapter: TrackBoxAdapter,
        adapter: AutomatableParameterFieldAdapter,
        startPos: ppqn,
        previousUnitValue: unitValue,
        value: unitValue,
        floating: boolean
    ): RecordingState => {
        const {boxGraph} = project
        const trackBox = trackBoxAdapter.box
        project.selection.deselect(
            ...trackBoxAdapter.regions.collection.asArray()
                .filter(region => region.isSelected)
                .map(region => region.box))
        RegionClipResolver.fromRange(trackBoxAdapter, startPos, startPos + PPQN.SemiQuaver)()
        const collectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        const regionBox = ValueRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(startPos)
            box.duration.setValue(PPQN.SemiQuaver)
            box.loopDuration.setValue(PPQN.SemiQuaver)
            box.hue.setValue(ColorCodes.forTrackType(TrackType.Value))
            box.label.setValue(adapter.name)
            box.events.refer(collectionBox.owners)
            box.regions.refer(trackBox.regions)
        })
        project.selection.select(regionBox)
        const interpolation = floating ? Interpolation.Linear : Interpolation.None
        let lastEventBox: ValueEventBox
        if (previousUnitValue !== value) {
            ValueEventBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(0)
                box.value.setValue(previousUnitValue)
                box.events.refer(collectionBox.events)
            })
            lastEventBox = ValueEventBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(0)
                box.index.setValue(1)
                box.value.setValue(value)
                box.events.refer(collectionBox.events)
            })
            InterpolationFieldAdapter.write(lastEventBox.interpolation, interpolation)
        } else {
            lastEventBox = ValueEventBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(0)
                box.value.setValue(value)
                box.events.refer(collectionBox.events)
            })
            InterpolationFieldAdapter.write(lastEventBox.interpolation, interpolation)
        }
        return {
            adapter, trackBoxAdapter, regionBox, collectionBox,
            startPosition: startPos, floating, lastValue: value,
            lastRelativePosition: 0, lastEventBox
        }
    }

    const simplifyRecordedEvents = ({boxAdapters}: Project, state: RecordingState): void => {
        if (!state.floating) {return}
        const adapter = boxAdapters.adapterFor(state.collectionBox, ValueEventCollectionBoxAdapter)
        const events = [...adapter.events.asArray()]
        const keep: typeof events = []
        for (const event of events) {
            while (keep.length >= 2) {
                const a = keep[keep.length - 2]
                const b = keep[keep.length - 1]
                if (a.position === b.position || b.position === event.position) {break}
                if (a.interpolation.type !== "linear" || b.interpolation.type !== "linear") {break}
                const t = (b.position - a.position) / (event.position - a.position)
                const expected = a.value + t * (event.value - a.value)
                if (Math.abs(b.value - expected) > Epsilon) {break}
                keep.pop()
                adapter.events.remove(b)
                b.box.delete()
            }
            keep.push(event)
        }
    }

    const handleWriteUpdate = (
        {boxGraph}: Project,
        state: RecordingState,
        position: ppqn,
        value: unitValue
    ): void => {
        if (position < state.startPosition) {return}
        const relativePosition = Math.trunc(position - state.startPosition)
        if (relativePosition < state.lastRelativePosition) {return}
        if (relativePosition === state.lastRelativePosition) {
            state.lastEventBox.value.setValue(value)
            state.lastValue = value
        } else {
            const interpolation = state.floating ? Interpolation.Linear : Interpolation.None
            state.lastEventBox = ValueEventBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(relativePosition)
                box.value.setValue(value)
                box.events.refer(state.collectionBox.events)
            })
            InterpolationFieldAdapter.write(state.lastEventBox.interpolation, interpolation)
            state.lastValue = value
            state.lastRelativePosition = relativePosition
        }
    }

    const finalizeState = (project: Project, state: RecordingState, finalPosition: ppqn): void => {
        const {boxGraph} = project
        if (!state.regionBox.isAttached()) {return}
        const finalDuration = Math.max(0,
            quantizeCeil(finalPosition - state.startPosition, PPQN.SemiQuaver))
        if (finalDuration <= 0) {
            state.regionBox.delete()
            return
        }
        const oldDuration = state.regionBox.duration.getValue()
        if (finalDuration > oldDuration) {
            RegionClipResolver.fromRange(
                state.trackBoxAdapter,
                state.startPosition + oldDuration,
                state.startPosition + finalDuration)()
        }
        if (finalDuration > state.lastRelativePosition) {
            ValueEventBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(finalDuration)
                box.value.setValue(state.lastValue)
                box.events.refer(state.collectionBox.events)
            })
        }
        state.regionBox.duration.setValue(finalDuration)
        state.regionBox.loopDuration.setValue(finalDuration)
        simplifyRecordedEvents(project, state)
    }

    const updateRegionDurations = (
        project: Project,
        activeRecordings: SortedSet<Address, RecordingState>,
        currentPosition: ppqn,
        loopEnabled: boolean,
        loopTo: ppqn
    ): void => {
        const {editing} = project
        editing.modify(() => {
            for (const state of activeRecordings.values()) {
                if (!state.regionBox.isAttached()) {continue}
                const oldDuration = state.regionBox.duration.getValue()
                const maxDuration = loopEnabled
                    ? loopTo - state.startPosition
                    : Infinity
                const newDuration = Math.max(PPQN.SemiQuaver,
                    quantizeCeil(
                        Math.min(maxDuration, currentPosition - state.startPosition),
                        PPQN.SemiQuaver))
                if (newDuration > oldDuration) {
                    RegionClipResolver.fromRange(
                        state.trackBoxAdapter,
                        state.startPosition + oldDuration,
                        state.startPosition + newDuration)()
                }
                state.regionBox.duration.setValue(newDuration)
                state.regionBox.loopDuration.setValue(newDuration)
            }
        }, false)
    }

    const handleLoopWrap = (
        project: Project,
        ctx: RecorderContext,
        activeRecordings: SortedSet<Address, RecordingState>,
        loopFrom: ppqn,
        loopTo: ppqn
    ): void => {
        const {editing, boxGraph} = project
        editing.modify(() => {
            const snapshot = [...activeRecordings.values()]
            for (const state of snapshot) {
                if (!state.regionBox.isAttached()) {continue}
                const finalDuration = Math.max(PPQN.SemiQuaver,
                    quantizeCeil(loopTo - state.startPosition, PPQN.SemiQuaver))
                const oldDuration = state.regionBox.duration.getValue()
                if (finalDuration > oldDuration) {
                    RegionClipResolver.fromRange(
                        state.trackBoxAdapter,
                        state.startPosition + oldDuration,
                        state.startPosition + finalDuration)()
                }
                if (finalDuration > state.lastRelativePosition) {
                    ValueEventBox.create(boxGraph, UUID.generate(), box => {
                        box.position.setValue(finalDuration)
                        box.value.setValue(state.lastValue)
                        box.events.refer(state.collectionBox.events)
                    })
                }
                state.regionBox.duration.setValue(finalDuration)
                state.regionBox.loopDuration.setValue(finalDuration)
                simplifyRecordedEvents(project, state)
                project.selection.deselect(state.regionBox)
                const newStartPos = quantizeFloor(loopFrom, PPQN.SemiQuaver)
                const newState = createRegion(
                    ctx, state.trackBoxAdapter, state.adapter, newStartPos,
                    state.lastValue, state.lastValue, state.floating)
                activeRecordings.removeByKey(state.adapter.address)
                activeRecordings.add(newState)
            }
        }, false)
    }

    export const start = (project: Project): Terminable => {
        const {editing, engine, parameterFieldAdapters, timelineBox} = project
        const ctx: RecorderContext = {project, parameterFieldAdapters}
        const activeRecordings: SortedSet<Address, RecordingState> =
            Address.newSet<RecordingState>(state => state.adapter.address)
        let lastPosition: ppqn = engine.position.getValue()
        const handleWrite = ({adapter, previousUnitValue}: ParameterWriteEvent): void => {
            if (!engine.isRecording.getValue()) {return}
            if (!parameterFieldAdapters.isTouched(adapter.address)) {return}
            const position = engine.position.getValue()
            const value = adapter.getUnitValue()
            const existingState = activeRecordings.opt(adapter.address)
            if (existingState.isEmpty()) {
                editing.modify(() => {
                    const trackOpt = findOrCreateTrack(ctx, adapter)
                    if (trackOpt.isEmpty()) {return}
                    const startPos = quantizeFloor(position, PPQN.SemiQuaver)
                    const floating = adapter.valueMapping.floating()
                    const state = createRegion(
                        ctx, trackOpt.unwrap(), adapter, startPos, previousUnitValue, value, floating)
                    activeRecordings.add(state)
                })
            } else {
                editing.modify(() => handleWriteUpdate(project, existingState.unwrap(), position, value), false)
            }
        }
        const handleTouchEnd = (address: Address): void => {
            const stateOpt = activeRecordings.opt(address)
            if (stateOpt.isEmpty()) {return}
            editing.modify(() => {
                finalizeState(project, stateOpt.unwrap(), engine.position.getValue())
                activeRecordings.removeByKey(address)
            })
        }
        const handlePosition = (): void => {
            if (!engine.isRecording.getValue()) {return}
            if (activeRecordings.size() === 0) {return}
            const currentPosition = engine.position.getValue()
            const loopEnabled = timelineBox.loopArea.enabled.getValue()
            const loopFrom = timelineBox.loopArea.from.getValue()
            const loopTo = timelineBox.loopArea.to.getValue()
            if (loopEnabled && currentPosition < lastPosition) {
                handleLoopWrap(project, ctx, activeRecordings, loopFrom, loopTo)
            }
            lastPosition = currentPosition
            updateRegionDurations(project, activeRecordings, currentPosition, loopEnabled, loopTo)
        }
        const handleTermination = (): void => {
            if (activeRecordings.size() === 0) {return}
            const finalPosition = engine.position.getValue()
            editing.modify(() => {
                for (const state of activeRecordings.values()) {
                    finalizeState(project, state, finalPosition)
                }
            })
        }
        return Terminable.many(
            parameterFieldAdapters.subscribeWrites(handleWrite),
            engine.position.subscribe(handlePosition),
            parameterFieldAdapters.subscribeTouchEnd(handleTouchEnd),
            Terminable.create(handleTermination))
    }

}

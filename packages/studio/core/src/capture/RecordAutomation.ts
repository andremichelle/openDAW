import {Option, quantizeCeil, quantizeFloor, SortedSet, Terminable, unitValue, UUID} from "@opendaw/lib-std"
import {Interpolation, ppqn, PPQN} from "@opendaw/lib-dsp"
import {Address} from "@opendaw/lib-box"
import {TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {
    AutomatableParameterFieldAdapter,
    ColorCodes,
    Devices,
    InterpolationFieldAdapter,
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

    const Eplison = 0.01

    export const start = (project: Project): Terminable => {
        const {editing, engine, boxAdapters, parameterFieldAdapters, boxGraph, timelineBox} = project
        const activeRecordings: SortedSet<Address, RecordingState> =
            Address.newSet<RecordingState>(state => state.adapter.address)
        let lastPosition: ppqn = engine.position.getValue()

        const createRegion = (
            trackBoxAdapter: TrackBoxAdapter,
            adapter: AutomatableParameterFieldAdapter,
            startPos: ppqn,
            previousUnitValue: unitValue,
            value: unitValue,
            floating: boolean
        ): RecordingState => {
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

        const findOrCreateTrack = (adapter: AutomatableParameterFieldAdapter): Option<TrackBoxAdapter> => {
            const deviceBox = adapter.field.box
            const deviceAdapterOpt = Option.tryCatch(() => boxAdapters.adapterFor(deviceBox, Devices.isAny))
            if (deviceAdapterOpt.isEmpty()) {
                console.warn(`Cannot record automation: could not find device adapter for ${deviceBox.name}`)
                return Option.None
            }
            const deviceAdapter = deviceAdapterOpt.unwrap()
            const audioUnitAdapter = deviceAdapter.audioUnitBoxAdapter()
            const tracks = audioUnitAdapter.tracks
            const existing = tracks.controls(adapter.field)
            if (existing.nonEmpty()) {return Option.wrap(existing.unwrap())}
            const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
                box.index.setValue(tracks.collection.getMinFreeIndex())
                box.type.setValue(TrackType.Value)
                box.tracks.refer(audioUnitAdapter.box.tracks)
                box.target.refer(adapter.field)
            })
            return Option.wrap(boxAdapters.adapterFor(trackBox, TrackBoxAdapter))
        }

        const handleWrite = ({adapter, previousUnitValue}: ParameterWriteEvent): void => {
            if (!engine.isRecording.getValue()) {return}
            const position = engine.position.getValue()
            const value = adapter.getUnitValue()
            const existingState = activeRecordings.opt(adapter.address)
            if (existingState.isEmpty()) {
                editing.modify(() => {
                    const trackOpt = findOrCreateTrack(adapter)
                    if (trackOpt.isEmpty()) {return}
                    const trackBoxAdapter = trackOpt.unwrap()
                    const startPos = quantizeFloor(position, PPQN.SemiQuaver)
                    const floating = adapter.valueMapping.floating()
                    const state = createRegion(
                        trackBoxAdapter, adapter, startPos, previousUnitValue, value, floating)
                    activeRecordings.add(state)
                })
            } else {
                const state = existingState.unwrap()
                if (position < state.startPosition) {return}
                const relativePosition = position - state.startPosition
                if (relativePosition < state.lastRelativePosition) {return}
                if (relativePosition === state.lastRelativePosition) {
                    editing.modify(() => {
                        state.lastEventBox.value.setValue(value)
                        state.lastValue = value
                    }, false)
                } else {
                    editing.modify(() => {
                        const interpolation = state.floating ? Interpolation.Linear : Interpolation.None
                        state.lastEventBox = ValueEventBox.create(boxGraph, UUID.generate(), box => {
                            box.position.setValue(relativePosition)
                            box.value.setValue(value)
                            box.events.refer(state.collectionBox.events)
                        })
                        InterpolationFieldAdapter.write(state.lastEventBox.interpolation, interpolation)
                        state.lastValue = value
                        state.lastRelativePosition = relativePosition
                    }, false)
                }
            }
        }

        const handlePosition = (): void => {
            if (!engine.isRecording.getValue()) {return}
            if (activeRecordings.size() === 0) {return}
            const currentPosition = engine.position.getValue()
            const loopEnabled = timelineBox.loopArea.enabled.getValue()
            const loopFrom = timelineBox.loopArea.from.getValue()
            const loopTo = timelineBox.loopArea.to.getValue()
            if (loopEnabled && currentPosition < lastPosition) {
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
                        simplifyRecordedEvents(state)
                        project.selection.deselect(state.regionBox)
                        const newStartPos = quantizeFloor(loopFrom, PPQN.SemiQuaver)
                        const newState = createRegion(
                            state.trackBoxAdapter, state.adapter, newStartPos,
                            state.lastValue, state.lastValue, state.floating)
                        activeRecordings.removeByKey(state.adapter.address)
                        activeRecordings.add(newState)
                    }
                }, false)
            }
            lastPosition = currentPosition
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

        const simplifyRecordedEvents = (state: RecordingState): void => {
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
                    if (Math.abs(b.value - expected) > Eplison) {break}
                    keep.pop()
                    b.box.delete()
                }
                keep.push(event)
            }
        }

        const handleTermination = (): void => {
            if (activeRecordings.size() === 0) {return}
            const finalPosition = engine.position.getValue()
            editing.modify(() => {
                for (const state of activeRecordings.values()) {
                    if (!state.regionBox.isAttached()) {continue}
                    const finalDuration = Math.max(0,
                        quantizeCeil(finalPosition - state.startPosition, PPQN.SemiQuaver))
                    if (finalDuration <= 0) {
                        state.regionBox.delete()
                        continue
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
                    simplifyRecordedEvents(state)
                }
            })
        }

        return Terminable.many(
            parameterFieldAdapters.subscribeWrites(handleWrite),
            engine.position.subscribe(handlePosition),
            Terminable.create(handleTermination))
    }
}

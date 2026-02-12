import {Option, Terminable, unitValue, UUID} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {
    AutomatableParameterFieldAdapter,
    ColorCodes,
    Devices,
    TrackBoxAdapter,
    TrackType,
    ValueRegionBoxAdapter
} from "@opendaw/studio-adapters"
import {Project} from "../project"
import {RegionClipResolver, RegionModifyStrategies} from "../ui"

export namespace RecordAutomation {
    type RecordingState = {
        adapter: AutomatableParameterFieldAdapter
        trackBox: TrackBox
        trackBoxAdapter: TrackBoxAdapter
        regionBox: ValueRegionBox
        collectionBox: ValueEventCollectionBox
        startPosition: ppqn
        lastValue: unitValue
        lastEventPosition: ppqn
        lastRelativePosition: ppqn
        lastEventBox: ValueEventBox
    }

    export const start = (project: Project): Terminable => {
        const {editing, engine, boxAdapters, parameterFieldAdapters, boxGraph} = project
        const activeRecordings = new Map<string, RecordingState>()
        return Terminable.many(
            parameterFieldAdapters.subscribeWrites(adapter => {
                if (!engine.isRecording.getValue()) {return}
                const key = adapter.address.toString()
                const position = engine.position.getValue()
                const value = adapter.getUnitValue()
                let state = activeRecordings.get(key)
                if (state === undefined) {
                    editing.modify(() => {
                        const deviceBox = adapter.field.box
                        const deviceAdapterOpt = Option.tryCatch(() => boxAdapters.adapterFor(deviceBox, Devices.isAny))
                        if (deviceAdapterOpt.isEmpty()) {
                            console.warn(`Cannot record automation: could not find device adapter for ${deviceBox.name}`)
                            return
                        }
                        const deviceAdapter = deviceAdapterOpt.unwrap()
                        const audioUnitAdapter = deviceAdapter.audioUnitBoxAdapter()
                        const tracks = audioUnitAdapter.tracks

                        let trackBox: TrackBox
                        let trackBoxAdapter: TrackBoxAdapter
                        const existing = tracks.controls(adapter.field)
                        if (existing.nonEmpty()) {
                            trackBoxAdapter = existing.unwrap()
                            trackBox = trackBoxAdapter.box
                        } else {
                            trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
                                box.index.setValue(tracks.collection.getMinFreeIndex())
                                box.type.setValue(TrackType.Value)
                                box.tracks.refer(audioUnitAdapter.box.tracks)
                                box.target.refer(adapter.field)
                            })
                            trackBoxAdapter = boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
                        }
                        const collectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate())
                        const regionBox = ValueRegionBox.create(boxGraph, UUID.generate(), box => {
                            box.position.setValue(position)
                            box.duration.setValue(0)
                            box.loopDuration.setValue(0)
                            box.hue.setValue(ColorCodes.forTrackType(TrackType.Value))
                            box.label.setValue(adapter.name)
                            box.events.refer(collectionBox.owners)
                            box.regions.refer(trackBox.regions)
                        })
                        const lastEventBox = ValueEventBox.create(boxGraph, UUID.generate(), box => {
                            box.position.setValue(0)
                            box.value.setValue(value)
                            box.events.refer(collectionBox.events)
                        })
                        state = {
                            adapter, trackBox, trackBoxAdapter, regionBox, collectionBox,
                            startPosition: position, lastValue: value, lastEventPosition: position,
                            lastRelativePosition: 0, lastEventBox
                        }
                        activeRecordings.set(key, state)
                    })
                } else {
                    const currentState = state
                    const relativePosition = Math.max(0, position - currentState.startPosition)
                    if (relativePosition === currentState.lastRelativePosition) {
                        editing.modify(() => {
                            currentState.lastEventBox.value.setValue(value)
                            currentState.lastValue = value
                        }, false)
                    } else {
                        editing.modify(() => {
                            currentState.lastEventBox = ValueEventBox.create(boxGraph, UUID.generate(), box => {
                                box.position.setValue(relativePosition)
                                box.value.setValue(value)
                                box.events.refer(currentState.collectionBox.events)
                            })
                            currentState.lastValue = value
                            currentState.lastEventPosition = position
                            currentState.lastRelativePosition = relativePosition
                        }, false)
                    }
                }
            }),
            engine.position.subscribe(owner => {
                if (!engine.isRecording.getValue()) {return}
                if (activeRecordings.size === 0) {return}
                const position = owner.getValue()
                editing.modify(() => {
                    for (const state of activeRecordings.values()) {
                        if (state.regionBox.isAttached()) {
                            const duration = Math.max(0, position - state.startPosition)
                            state.regionBox.duration.setValue(duration)
                            state.regionBox.loopDuration.setValue(duration)
                        }
                    }
                }, false)
            }),
            Terminable.create(() => {
                if (activeRecordings.size === 0) {return}
                const finalPosition = engine.position.getValue()
                editing.modify(() => {
                    for (const state of activeRecordings.values()) {
                        if (!state.regionBox.isAttached()) {continue}
                        const duration = Math.max(0, finalPosition - state.startPosition)
                        if (duration <= 0) {
                            state.regionBox.delete()
                            continue
                        }
                        const regionAdapter = boxAdapters.adapterFor(state.regionBox, ValueRegionBoxAdapter)
                        regionAdapter.onSelected()
                        RegionClipResolver.fromRange(
                            state.trackBoxAdapter,
                            state.startPosition,
                            state.startPosition + duration,
                            /*RegionModifyStrategies.Identity*/
                        )()
                        regionAdapter.onDeselected()
                        if (duration !== state.lastRelativePosition) {
                            ValueEventBox.create(boxGraph, UUID.generate(), box => {
                                box.position.setValue(duration)
                                box.value.setValue(state.lastValue)
                                box.events.refer(state.collectionBox.events)
                            })
                        }
                        state.regionBox.duration.setValue(duration)
                        state.regionBox.loopDuration.setValue(duration)
                    }
                })
            }))
    }
}

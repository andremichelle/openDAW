import {Option, Terminable, Terminator, unitValue, UUID} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {AutomatableParameterFieldAdapter, ColorCodes, Devices, TrackType} from "@opendaw/studio-adapters"
import {Project} from "../project"

export namespace RecordAutomation {
    type RecordingState = {
        adapter: AutomatableParameterFieldAdapter
        trackBox: TrackBox
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
        const terminator = new Terminator()
        const activeRecordings = new Map<string, RecordingState>()

        // Subscribe to parameter writes
        terminator.own(parameterFieldAdapters.subscribeWrites(adapter => {
            if (!engine.isRecording.getValue()) {return}

            const key = adapter.address.toString()
            const position = engine.position.getValue()
            const value = adapter.getUnitValue()

            let state = activeRecordings.get(key)
            if (state === undefined) {
                // First touch - create track and region
                editing.modify(() => {
                    // Navigate: parameter field → device box → device adapter → audio unit
                    const deviceBox = adapter.field.box
                    const deviceAdapterOpt = Option.tryCatch(() => boxAdapters.adapterFor(deviceBox, Devices.isAny))
                    if (deviceAdapterOpt.isEmpty()) {
                        console.warn(`Cannot record automation: could not find device adapter for ${deviceBox.name}`)
                        return
                    }
                    const deviceAdapter = deviceAdapterOpt.unwrap()
                    const audioUnitAdapter = deviceAdapter.audioUnitBoxAdapter()
                    const tracks = audioUnitAdapter.tracks

                    // Find or create automation track for this parameter
                    let trackBox: TrackBox
                    const existing = tracks.controls(adapter.field)
                    if (existing.nonEmpty()) {
                        trackBox = existing.unwrap().box
                    } else {
                        trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
                            box.index.setValue(tracks.collection.getMinFreeIndex())
                            box.type.setValue(TrackType.Value)
                            box.tracks.refer(audioUnitAdapter.box.tracks)
                            box.target.refer(adapter.field)
                        })
                    }

                    // Create region and event collection
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

                    // Add initial value event
                    const lastEventBox = ValueEventBox.create(boxGraph, UUID.generate(), box => {
                        box.position.setValue(0)
                        box.value.setValue(value)
                        box.events.refer(collectionBox.events)
                    })

                    state = {
                        adapter, trackBox, regionBox, collectionBox,
                        startPosition: position, lastValue: value, lastEventPosition: position,
                        lastRelativePosition: 0, lastEventBox
                    }
                    activeRecordings.set(key, state)
                })
            } else {
                // Add new value event (relative to region start)
                const currentState = state
                const relativePosition = Math.max(0, position - currentState.startPosition)

                // If at the same position, update existing event instead of creating new one
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
        }))

        // Position updates: extend regions
        terminator.own(engine.position.subscribe(owner => {
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
        }))

        // Finalize on termination
        terminator.own(Terminable.create(() => {
            if (activeRecordings.size === 0) {return}
            const finalPosition = engine.position.getValue()
            editing.modify(() => {
                for (const state of activeRecordings.values()) {
                    if (!state.regionBox.isAttached()) {continue}
                    // Ensure final value event at end position (latch)
                    const duration = Math.max(0, finalPosition - state.startPosition)
                    // Only add final event if position is different from last event
                    if (duration > 0 && duration !== state.lastRelativePosition) {
                        ValueEventBox.create(boxGraph, UUID.generate(), box => {
                            box.position.setValue(duration)
                            box.value.setValue(state.lastValue)
                            box.events.refer(state.collectionBox.events)
                        })
                    }
                    // Finalize region duration
                    state.regionBox.duration.setValue(duration)
                    state.regionBox.loopDuration.setValue(duration)
                }
            })
        }))

        return terminator
    }
}

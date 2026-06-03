import {beforeEach, describe, expect, it} from "vitest"
import {Arrays, asInstanceOf, assert, Bijective, isInstanceOf, MutableObservableOption, Predicate, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {AudioBusBox, AudioUnitBox, RootBox, SelectionBox, UserInterfaceBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {RemoteSelections} from "./RemoteSelections"
import {SelectableVertex} from "./SelectableVertex"

type Event = { type: "+" | "-", selectable: SelectableVertex, user: UserInterfaceBox }

describe("RemoteSelections", () => {
    let boxGraph: BoxGraph
    let rootBox: RootBox
    let primaryAudioBusBox: AudioBusBox
    let userA: UserInterfaceBox
    let followed: MutableObservableOption<UserInterfaceBox>
    let nextIndex: number

    beforeEach(() => {
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        boxGraph = skeleton.boxGraph
        rootBox = skeleton.mandatoryBoxes.rootBox
        primaryAudioBusBox = skeleton.mandatoryBoxes.primaryAudioBusBox
        userA = skeleton.mandatoryBoxes.userInterfaceBoxes[0]
        followed = new MutableObservableOption<UserInterfaceBox>()
        nextIndex = 1
    })

    const createUser = (): UserInterfaceBox => {
        boxGraph.beginTransaction()
        const user = UserInterfaceBox.create(boxGraph, UUID.generate(), box => box.root.refer(rootBox.users))
        boxGraph.endTransaction()
        return user
    }
    const createSelectable = (): AudioUnitBox => {
        boxGraph.beginTransaction()
        const box = AudioUnitBox.create(boxGraph, UUID.generate(), unit => {
            unit.type.setValue(AudioUnitType.Instrument)
            unit.collection.refer(rootBox.audioUnits)
            unit.output.refer(primaryAudioBusBox.input)
            unit.index.setValue(nextIndex++)
        })
        boxGraph.endTransaction()
        return box
    }
    const select = (user: UserInterfaceBox, selectable: SelectableVertex): SelectionBox => {
        boxGraph.beginTransaction()
        const box = SelectionBox.create(boxGraph, UUID.generate(), selectionBox => {
            selectionBox.selectable.refer(selectable)
            selectionBox.selection.refer(user.selection)
        })
        boxGraph.endTransaction()
        return box
    }
    const remove = (box: {delete(): void}): void => {
        boxGraph.beginTransaction()
        box.delete()
        boxGraph.endTransaction()
    }
    const record = (remote: RemoteSelections): ReadonlyArray<Event> => {
        const events: Array<Event> = []
        remote.subscribe({
            onSelected: (selectable, user) => events.push({type: "+", selectable, user}),
            onDeselected: (selectable, user) => events.push({type: "-", selectable, user})
        })
        return events
    }

    describe("single user (the blazingly fast path)", () => {
        it("excludes the followed user, so the index stays empty", () => {
            const remote = new RemoteSelections(rootBox, followed)
            followed.wrap(userA)
            const selectable = createSelectable()
            select(userA, selectable)
            expect(remote.ownersOf(selectable)).toHaveLength(0)
        })

        it("returns the shared frozen empty array on a miss (zero allocation per paint)", () => {
            const remote = new RemoteSelections(rootBox, followed)
            followed.wrap(userA)
            const selectable = createSelectable()
            expect(remote.ownersOf(selectable)).toBe(Arrays.empty())
            select(userA, selectable)
            expect(remote.ownersOf(selectable)).toBe(Arrays.empty())
        })
    })

    describe("remote users", () => {
        it("indexes a remote user's selection and notifies", () => {
            followed.wrap(userA)
            const remote = new RemoteSelections(rootBox, followed)
            const events = record(remote)
            const userB = createUser()
            const selectable = createSelectable()
            select(userB, selectable)
            const owners = remote.ownersOf(selectable)
            expect(owners).toHaveLength(1)
            expect(owners[0]).toBe(userB)
            expect(events).toEqual([{type: "+", selectable, user: userB}])
        })

        it("catches a late subscriber up to existing selections", () => {
            followed.wrap(userA)
            const remote = new RemoteSelections(rootBox, followed)
            const userB = createUser()
            const selectable = createSelectable()
            select(userB, selectable)
            const events: Array<Event> = []
            remote.catchupAndSubscribe({
                onSelected: (selectable, user) => events.push({type: "+", selectable, user}),
                onDeselected: (selectable, user) => events.push({type: "-", selectable, user})
            })
            expect(events).toEqual([{type: "+", selectable, user: userB}])
        })

        it("tracks many owners on one selectable", () => {
            followed.wrap(userA)
            const remote = new RemoteSelections(rootBox, followed)
            const userB = createUser()
            const userC = createUser()
            const selectable = createSelectable()
            select(userB, selectable)
            select(userC, selectable)
            const owners = remote.ownersOf(selectable)
            expect(owners).toHaveLength(2)
            expect(owners).toContain(userB)
            expect(owners).toContain(userC)
        })

        it("evicts a single owner on deselect, keeping the others", () => {
            followed.wrap(userA)
            const remote = new RemoteSelections(rootBox, followed)
            const userB = createUser()
            const userC = createUser()
            const selectable = createSelectable()
            select(userB, selectable)
            const selectionC = select(userC, selectable)
            const events = record(remote)
            remove(selectionC)
            expect(remote.ownersOf(selectable)).toHaveLength(1)
            expect(remote.ownersOf(selectable)[0]).toBe(userB)
            expect(events).toEqual([{type: "-", selectable, user: userC}])
        })

        it("falls back to the empty array once the last owner deselects", () => {
            followed.wrap(userA)
            const remote = new RemoteSelections(rootBox, followed)
            const userB = createUser()
            const selectable = createSelectable()
            const selection = select(userB, selectable)
            remove(selection)
            expect(remote.ownersOf(selectable)).toBe(Arrays.empty())
        })

        it("evicts every entry of a user that leaves and notifies for each", () => {
            followed.wrap(userA)
            const remote = new RemoteSelections(rootBox, followed)
            const userB = createUser()
            const selectableOne = createSelectable()
            const selectableTwo = createSelectable()
            select(userB, selectableOne)
            select(userB, selectableTwo)
            const events = record(remote)
            remove(userB) // user leaves: box removed, dropping its pointer from rootBox.users
            expect(remote.ownersOf(selectableOne)).toHaveLength(0)
            expect(remote.ownersOf(selectableTwo)).toHaveLength(0)
            expect(events.filter(event => event.type === "-")).toHaveLength(2)
        })

        it("skips a dangling selection on catch-up without throwing (no transaction reject)", () => {
            followed.wrap(userA)
            const userB = createUser()
            const selectable = createSelectable()
            select(userB, selectable)
            remove(selectable) // selectable gone, but the SelectionBox lingers with a dangling target
            const remote = new RemoteSelections(rootBox, followed) // watcher catches up the dangling box
            const events = record(remote)
            const other = createSelectable()
            select(userB, other) // a healthy selection must still flow
            expect(remote.ownersOf(selectable)).toHaveLength(0)
            expect(remote.ownersOf(other)).toHaveLength(1)
            expect(events).toEqual([{type: "+", selectable: other, user: userB}])
        })

        it("still evicts when the selectable target was already detached", () => {
            followed.wrap(userA)
            const remote = new RemoteSelections(rootBox, followed)
            const userB = createUser()
            const selectable = createSelectable()
            const selection = select(userB, selectable)
            const events = record(remote)
            remove(selectable) // selectable gone first; SelectionBox.selectable can no longer resolve
            remove(selection) // removal must still resolve the selectable via the box map
            expect(events).toEqual([{type: "-", selectable, user: userB}])
        })
    })

    describe("dynamic following", () => {
        it("moves the previously followed user into the index and drops the newly followed user", () => {
            followed.wrap(userA)
            const remote = new RemoteSelections(rootBox, followed)
            const userB = createUser()
            const selectableA = createSelectable()
            const selectableB = createSelectable()
            select(userA, selectableA)
            select(userB, selectableB)
            expect(remote.ownersOf(selectableA)).toHaveLength(0)
            expect(remote.ownersOf(selectableB)).toHaveLength(1)
            followed.wrap(userB)
            expect(remote.ownersOf(selectableA)).toHaveLength(1)
            expect(remote.ownersOf(selectableA)[0]).toBe(userA)
            expect(remote.ownersOf(selectableB)).toHaveLength(0)
        })

        it("makes every user remote once following is released", () => {
            followed.wrap(userA)
            const remote = new RemoteSelections(rootBox, followed)
            const selectable = createSelectable()
            select(userA, selectable)
            expect(remote.ownersOf(selectable)).toHaveLength(0)
            followed.clear()
            expect(remote.ownersOf(selectable)).toHaveLength(1)
            expect(remote.ownersOf(selectable)[0]).toBe(userA)
        })
    })

    describe("FilteredRemoteSelection scope", () => {
        const audioUnitFilter: Predicate<SelectableVertex> = vertex => isInstanceOf(vertex.box, AudioUnitBox)
        const audioUnitMapping: Bijective<AudioUnitBox, SelectableVertex> = {
            fx: (unit: AudioUnitBox) => unit,
            fy: (vertex: SelectableVertex) => {
                const box = asInstanceOf(vertex.box, AudioUnitBox)
                assert(box.isAttached(), "mapping must never resolve a detached box")
                return box
            }
        }

        it("only forwards selectables that match the predicate", () => {
            followed.wrap(userA)
            const remote = new RemoteSelections(rootBox, followed)
            const view = remote.createFilteredSelection(audioUnitFilter, audioUnitMapping)
            const seen: Array<AudioUnitBox> = []
            view.subscribe({
                onSelected: (unit: AudioUnitBox) => seen.push(unit),
                onDeselected: () => {}
            })
            const userB = createUser()
            const selectable = createSelectable()
            select(userB, primaryAudioBusBox) // an AudioBusBox: out of scope, must not reach the view
            select(userB, selectable)
            expect(seen).toHaveLength(1)
            expect(seen[0]).toBe(selectable)
            expect(view.ownersOf(selectable)).toHaveLength(1)
            expect(view.ownersOf(selectable)[0]).toBe(userB)
        })

        it("does not re-map the selectable on deselect, so a deleted box never panics", () => {
            followed.wrap(userA)
            const remote = new RemoteSelections(rootBox, followed)
            const view = remote.createFilteredSelection(audioUnitFilter, audioUnitMapping)
            const deselected: Array<AudioUnitBox> = []
            view.subscribe({
                onSelected: () => {},
                onDeselected: (unit: AudioUnitBox) => deselected.push(unit)
            })
            const userB = createUser()
            const selectable = createSelectable()
            const selection = select(userB, selectable)
            remove(selectable) // delete the selectable box first
            remove(selection) // its removal must not resolve a fresh adapter for the deleted box
            expect(deselected).toHaveLength(1)
            expect(deselected[0]).toBe(selectable)
            expect(view.ownersOf(selectable)).toHaveLength(0)
        })

        it("catches up scoped to the predicate", () => {
            followed.wrap(userA)
            const remote = new RemoteSelections(rootBox, followed)
            const userB = createUser()
            const selectable = createSelectable()
            select(userB, selectable)
            select(userB, primaryAudioBusBox)
            const view = remote.createFilteredSelection(audioUnitFilter, audioUnitMapping)
            const seen: Array<AudioUnitBox> = []
            view.catchupAndSubscribe({
                onSelected: (unit: AudioUnitBox) => seen.push(unit),
                onDeselected: () => {}
            })
            expect(seen).toEqual([selectable])
        })
    })
})

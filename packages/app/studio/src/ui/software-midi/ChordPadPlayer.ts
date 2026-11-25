import {
    Arrays, int, isDefined, Notifier, Nullable, Observer, ObservableValue, Option, Subscription, Terminable, Terminator, UUID
} from "@opendaw/lib-std"
import {Harmony, ppqn} from "@opendaw/lib-dsp"
import {MidiDevices, Project} from "@opendaw/studio-core"
import {ChordEventBox} from "@opendaw/studio-boxes"
import {ChordOverlaps} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"

type Held = { pitches: ReadonlyArray<int>, recording: Nullable<{ start: ppqn, end: ppqn }> }

export class ChordPadPlayer implements Terminable {
    static readonly NumPads = 7

    readonly #terminator = new Terminator()
    readonly #service: StudioService
    readonly #octave: ObservableValue<int>
    readonly #velocity: ObservableValue<int>
    readonly #held: Array<Nullable<Held>>
    readonly #notifier: Notifier<void>

    constructor(service: StudioService, octave: ObservableValue<int>, velocity: ObservableValue<int>) {
        this.#service = service
        this.#octave = octave
        this.#velocity = velocity
        this.#held = Arrays.create(() => null, ChordPadPlayer.NumPads)
        this.#notifier = new Notifier<void>()
        const projectLifetime = this.#terminator.own(new Terminator())
        this.#terminator.own(service.projectProfileService.catchupAndSubscribe(optProfile => {
            projectLifetime.terminate()
            this.#held.forEach(held => {if (isDefined(held)) {held.recording = null}})
            this.releaseAll()
            optProfile.ifSome(({project}) => {
                const {engine: {position, isRecording}} = project
                projectLifetime.ownAll(
                    position.subscribe(owner => this.#held.forEach(held => {
                        if (isDefined(held?.recording) && isRecording.getValue()) {held.recording.end = owner.getValue()}
                    })),
                    isRecording.subscribe(owner => {
                        if (owner.getValue()) {return}
                        this.#held.forEach((held, index) => {
                            if (!isDefined(held?.recording)) {return}
                            this.#write(project, index + 1, held.recording)
                            held.recording = null
                        })
                    })
                )
            })
        }))
    }

    subscribe(observer: Observer<void>): Subscription {return this.#notifier.subscribe(observer)}

    isActive(degree: int): boolean {return isDefined(this.#held[degree - 1])}

    press(degree: int): void {
        if (this.isActive(degree)) {return}
        const {softwareMIDIInput} = MidiDevices
        const base = this.#octave.getValue() * 12
        const pitches = this.chordAt(degree).mapOr(({root, voicing}) => voicing
            .map(interval => base + root + interval)
            .filter(pitch => pitch >= 0 && pitch < 128), [])
        if (pitches.length === 0) {return}
        pitches.forEach(pitch => softwareMIDIInput.sendNoteOn(pitch, this.#velocity.getValue() / 100.0))
        const recording = this.#service.projectProfileService.getValue().match({
            none: () => null,
            some: ({project: {engine: {isRecording, isCountingIn, position}}}) =>
                isRecording.getValue() && !isCountingIn.getValue()
                    ? {start: position.getValue(), end: position.getValue()} : null
        })
        this.#held[degree - 1] = {pitches, recording}
        this.#notifier.notify()
    }

    release(degree: int): void {
        const held = this.#held[degree - 1]
        if (!isDefined(held)) {return}
        this.#held[degree - 1] = null
        held.pitches.forEach(pitch => MidiDevices.softwareMIDIInput.sendNoteOff(pitch))
        if (isDefined(held.recording)) {
            const recording = held.recording
            this.#service.projectProfileService.getValue().ifSome(({project}) => this.#write(project, degree, recording))
        }
        this.#notifier.notify()
    }

    releaseAll(): void {
        for (let degree = 1; degree <= ChordPadPlayer.NumPads; degree++) {this.release(degree)}
    }

    terminate(): void {
        this.releaseAll()
        this.#terminator.terminate()
    }

    chordAt(degree: int): Option<Harmony.Chord> {
        return this.#service.projectProfileService.getValue().match({
            none: () => Harmony.chord(Harmony.DefaultKey, degree, 0, 0),
            some: ({project: {engine, timelineBoxAdapter: {keyTrack}}}) =>
                Harmony.chord(keyTrack.keyAt(engine.position.getValue()), degree, 0, 0)
        })
    }

    #write(project: Project, degree: int, {start, end}: { start: ppqn, end: ppqn }): void {
        const {editing, boxGraph, timelineBox: {loopArea}, timelineBoxAdapter: {chordTrack}} = project
        const {snapping, primaryVisibility} = this.#service.timeline
        const position = snapping.round(start)
        const complete = Math.max(snapping.round(end < start ? loopArea.to.getValue() : end),
            position + snapping.value(position))
        editing.modify(() => {
            const box = ChordEventBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(position)
                box.duration.setValue(complete - position)
                box.degree.setValue(degree)
                box.track.refer(chordTrack.object.events)
            })
            ChordOverlaps.resolve(boxGraph, chordTrack.events.asArray().map(({box}) => box), [box])
        })
        primaryVisibility.chords.setValue(true)
    }
}

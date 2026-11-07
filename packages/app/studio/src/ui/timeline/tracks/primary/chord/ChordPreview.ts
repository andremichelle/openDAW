import {Harmony} from "@opendaw/lib-dsp"
import {Devices, NoteSignal} from "@opendaw/studio-adapters"
import {MidiDevices, Project} from "@opendaw/studio-core"
import {Terminable} from "@opendaw/lib-std"

export namespace ChordPreview {
    const BasePitch = 48
    const DurationMs = 600

    export const start = (project: Project, chord: Harmony.Chord): Terminable => {
        const host = project.userEditingManager.audioUnit.get()
            .map(vertex => project.boxAdapters.adapterFor(vertex.box, Devices.isHost))
        if (host.isEmpty()) {return Terminable.Empty}
        const uuid = host.unwrap().audioUnitBoxAdapter().box.address.uuid
        const pitches = chord.voicing.map(interval => BasePitch + chord.root + interval)
        pitches.forEach(pitch => project.engine.noteSignal(NoteSignal.on(uuid, pitch, 0.8)))
        return Terminable.create(() => pitches.forEach(pitch => project.engine.noteSignal(NoteSignal.off(uuid, pitch))))
    }

    export const press = (project: Project, chord: Harmony.Chord): Terminable => {
        if (!project.engine.isRecording.getValue()) {return start(project, chord)}
        const {softwareMIDIInput} = MidiDevices
        const pitches = chord.voicing.map(interval => BasePitch + chord.root + interval)
        pitches.forEach(pitch => softwareMIDIInput.sendNoteOn(pitch, 0.8))
        return Terminable.create(() => pitches.forEach(pitch => softwareMIDIInput.sendNoteOff(pitch)))
    }

    export const play = (project: Project, chord: Harmony.Chord): void => {
        const playing = start(project, chord)
        setTimeout(() => playing.terminate(), DurationMs)
    }
}

import {Harmony} from "@opendaw/lib-dsp"
import {Devices, NoteSignal} from "@opendaw/studio-adapters"
import {Project} from "@opendaw/studio-core"

export namespace ChordPreview {
    const BasePitch = 48
    const DurationMs = 600

    export const play = (project: Project, chord: Harmony.Chord): void => {
        const host = project.userEditingManager.audioUnit.get()
            .map(vertex => project.boxAdapters.adapterFor(vertex.box, Devices.isHost))
        if (host.isEmpty()) {return}
        const uuid = host.unwrap().audioUnitBoxAdapter().box.address.uuid
        const pitches: Array<number> = []
        for (let interval = 0; interval < 12; interval++) {
            if ((chord.bits & (1 << interval)) !== 0) {pitches.push(BasePitch + chord.root + interval)}
        }
        pitches.forEach(pitch => project.engine.noteSignal(NoteSignal.on(uuid, pitch, 0.8)))
        setTimeout(() => pitches.forEach(pitch => project.engine.noteSignal(NoteSignal.off(uuid, pitch))), DurationMs)
    }
}

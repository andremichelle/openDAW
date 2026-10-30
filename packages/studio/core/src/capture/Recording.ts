import {Option, Terminable} from "@opendaw/lib-std"
import {Project} from "../project"
import {ppqn} from "@opendaw/lib-dsp"
import {RecordingSession} from "./RecordingSession"

// facade over the project's RecordingSession, kept for SDK consumers
export class Recording {
    static get isRecording(): boolean {return RecordingSession.anyRecording}

    static async start(project: Project, countIn: boolean): Promise<Terminable> {
        this.#last = Option.wrap(project.recordingSession)
        return project.recordingSession.start(countIn)
    }

    static #last: Option<RecordingSession> = Option.None

    static wasCountingIn(): boolean {return this.#last.mapOr(session => session.wasCountingIn, false)}
    static wasStartingAt(): ppqn {return this.#last.mapOr(session => session.startPosition, 0.0)}
}

import {Terminable, UUID} from "@opendaw/lib-std"
import {ParameterWriteEvent} from "@opendaw/studio-adapters"
import {Project} from "./Project"

/// #347: a parameter changed by hand or by MIDI takes over from its own automation for as long as the transport
/// runs, so the manual value is heard at once instead of fighting the curve (the engine reads the parameter's
/// field while its lane is suspended, modulation still applies). Runtime only, nothing is written to the box
/// graph: the engine drops every suspension on pause, stop and stopRecording, so the next play reads the curve.
export namespace AutomationSuspension {
    export const start = ({engine, parameterFieldAdapters}: Project): Terminable => {
        const suspended = new Set<string>()
        return Terminable.many(
            parameterFieldAdapters.subscribeWrites(({adapter}: ParameterWriteEvent) => {
                if (!engine.isPlaying.getValue()) {return}
                adapter.track.ifSome(({uuid}) => {
                    const key = UUID.toString(uuid)
                    if (suspended.has(key)) {return}
                    suspended.add(key)
                    engine.suspendAutomation(uuid)
                })
            }),
            engine.isPlaying.subscribe(owner => {if (!owner.getValue()) {suspended.clear()}})
        )
    }
}

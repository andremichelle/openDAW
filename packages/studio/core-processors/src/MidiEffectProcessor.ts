import {Processor} from "./processing"
import {NoteEventSource, NoteEventTarget} from "./NoteEventSource"
import {int, Terminable, UUID} from "@moises-ai/lib-std"
import {MidiEffectDeviceAdapter} from "@moises-ai/studio-adapters"

export interface MidiEffectProcessor extends Processor, NoteEventSource, NoteEventTarget, Terminable {
    get uuid(): UUID.Bytes

    index(): int
    adapter(): MidiEffectDeviceAdapter
}
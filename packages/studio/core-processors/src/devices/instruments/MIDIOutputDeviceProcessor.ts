import {Arrays, asInstanceOf, byte, int, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioBuffer, Event, PPQN} from "@opendaw/lib-dsp"
import {MIDIOutputDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {AudioProcessor} from "../../AudioProcessor"
import {Block, Processor} from "../../processing"
import {AutomatableParameter} from "../../AutomatableParameter"
import {NoteEventSource, NoteEventTarget, NoteLifecycleEvent} from "../../NoteEventSource"
import {DeviceProcessor} from "../../DeviceProcessor"
import {InstrumentDeviceProcessor} from "../../InstrumentDeviceProcessor"
import {MidiData} from "@opendaw/lib-midi"
import {MIDIOutputBox, MIDIOutputParameterBox} from "@opendaw/studio-boxes"

export class MIDIOutputDeviceProcessor extends AudioProcessor implements InstrumentDeviceProcessor, NoteEventTarget {
    readonly #adapter: MIDIOutputDeviceBoxAdapter

    readonly #audioOutput: AudioBuffer

    readonly #activeNotes: Array<byte> = []

    readonly #parameters: Array<AutomatableParameter<number>>

    #lastChannel: byte
    #enabled: boolean = true
    #source: Option<NoteEventSource> = Option.None

    constructor(context: EngineContext, adapter: MIDIOutputDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#audioOutput = new AudioBuffer()
        this.#parameters = []

        const {midiDevice, box, parameters} = adapter

        this.#lastChannel = box.channel.getValue()

        this.ownAll(
            box.enabled.catchupAndSubscribe(owner => {
                this.#enabled = owner.getValue()
                if (!this.#enabled) {this.reset()}
            }),
            box.parameters.pointerHub.catchupAndSubscribe({
                onAdded: (({box}) =>
                    this.#parameters.push(this.bindParameter(
                        parameters.parameterAt(asInstanceOf(box, MIDIOutputParameterBox).value.address)))),
                onRemoved: (({box}) =>
                    Arrays.removeIf(this.#parameters, parameter =>
                        parameter.address === asInstanceOf(box, MIDIOutputParameterBox).value.address))
            }),
            box.channel.subscribe(owner => {
                midiDevice.ifSome(outputBox => this.#activeNotes.forEach(pitch =>
                    context.sendMIDIData(outputBox.id.getValue(),
                        MidiData.noteOff(this.#lastChannel, pitch), outputBox.delayInMs.getValue())))
                this.#activeNotes.length = 0
                this.#lastChannel = owner.getValue()
            }),
            context.registerProcessor(this)
        )
        this.readAllParameters()
    }

    get noteEventTarget(): Option<NoteEventTarget & DeviceProcessor> {return Option.wrap(this)}

    introduceBlock({p0, p1, s0, flags, bpm}: Block): void {
        if (this.#source.isEmpty() || !this.#enabled) {return}
        const {box: {channel, device}} = this.#adapter
        const optDevice = device.targetVertex.match({
            none: () => Option.None,
            some: ({box}) => Option.wrap(asInstanceOf(box, MIDIOutputBox))
        })
        const delayInMs = optDevice.mapOr(box => box.delayInMs.getValue(), 0)
        for (const event of this.#source.unwrap().processNotes(p0, p1, flags)) {
            if (event.pitch >= 0 && event.pitch <= 127) {
                const blockOffsetInSeconds = s0 / sampleRate
                const eventOffsetInSeconds = PPQN.pulsesToSeconds(event.position - p0, bpm)
                const relativeTimeInMs = (blockOffsetInSeconds + eventOffsetInSeconds) * 1000.0 + delayInMs
                const channelIndex = channel.getValue()
                if (NoteLifecycleEvent.isStart(event)) {
                    const velocityAsByte = Math.round(event.velocity * 127)
                    this.#activeNotes.push(event.pitch)
                    optDevice.ifSome(device => this.context.sendMIDIData(device.id.getValue(),
                        MidiData.noteOn(channelIndex, event.pitch, velocityAsByte), relativeTimeInMs))
                } else if (NoteLifecycleEvent.isStop(event)) {
                    const deleteIndex = this.#activeNotes.indexOf(event.pitch)
                    if (deleteIndex > -1) {this.#activeNotes.splice(deleteIndex, 1)}
                    optDevice.ifSome(optDevice => this.context.sendMIDIData(optDevice.id.getValue(),
                        MidiData.noteOff(channelIndex, event.pitch), relativeTimeInMs))
                }
            }
        }
    }

    setNoteEventSource(source: NoteEventSource): Terminable {
        this.#source = Option.wrap(source)
        return Terminable.create(() => this.#source = Option.None)
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {}

    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get audioOutput(): AudioBuffer {return this.#audioOutput}
    get adapter(): MIDIOutputDeviceBoxAdapter {return this.#adapter}

    handleEvent(_event: Event): void {}
    processAudio(_block: Block, _fromIndex: int, _toIndex: int): void {}

    parameterChanged(parameter: AutomatableParameter, relativeBlockTime: number = 0.0): void {
        const {box: {channel, device}} = this.#adapter
        if (device.isEmpty() || !this.#enabled) {return}
        const {id, delayInMs} = asInstanceOf(device.targetVertex.unwrap().box, MIDIOutputBox)
        const relativeTimeInMs = relativeBlockTime * 1000.0 * delayInMs.getValue()
        const controllerId = asInstanceOf(parameter.adapter.field.box, MIDIOutputParameterBox).controller.getValue()
        const velocityAsByte = Math.round(parameter.getValue() * 127)
        const data = MidiData.control(channel.getValue(), controllerId, velocityAsByte)
        this.context.sendMIDIData(id.getValue(), data, relativeTimeInMs)
    }

    finishProcess(): void {}

    toString(): string {return `{MIDIOutputDeviceProcessor}`}
}
import {byte, int, isAbsent, isUndefined, Option, Optional, Terminable, UUID} from "@opendaw/lib-std"
import {AudioBuffer, Event} from "@opendaw/lib-dsp"
import {SoundfontDeviceBoxAdapter, SoundfontLoader} from "@opendaw/studio-adapters"
import type {InstrumentZone, Preset, PresetZone} from "soundfont2"
import {AudioProcessor} from "../../AudioProcessor"
import {InstrumentDeviceProcessor} from "../../InstrumentDeviceProcessor"
import {NoteEventSource, NoteEventTarget, NoteLifecycleEvent} from "../../NoteEventSource"
import {NoteEventInstrument} from "../../NoteEventInstrument"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {EngineContext} from "../../EngineContext"
import {DeviceProcessor} from "../../DeviceProcessor"
import {Block, Processor} from "../../processing"
import {SoundfontVoice} from "./Soundfont/SoundfontVoice"
import {GeneratorType, Range} from "./Soundfont/GeneratorType"

export class SoundfontDeviceProcessor extends AudioProcessor implements InstrumentDeviceProcessor, NoteEventTarget {
    readonly #adapter: SoundfontDeviceBoxAdapter
    readonly #voices: Array<SoundfontVoice>
    readonly #noteEventInstrument: NoteEventInstrument
    readonly #audioOutput: AudioBuffer
    readonly #peakBroadcaster: PeakBroadcaster

    #loader: Option<SoundfontLoader> = Option.None

    constructor(context: EngineContext, adapter: SoundfontDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#voices = []
        this.#noteEventInstrument = new NoteEventInstrument(this, context.broadcaster, adapter.audioUnitBoxAdapter().address)
        this.#audioOutput = new AudioBuffer()
        this.#peakBroadcaster = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))

        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#audioOutput, this.outgoing),
            adapter.box.file.catchupAndSubscribe((pointer) =>
                this.#loader = pointer.targetVertex.map(({box}) =>
                    context.soundfontManager.getOrCreate(box.address.uuid)))
        )
    }

    introduceBlock(block: Block): void {this.#noteEventInstrument.introduceBlock(block)}
    setNoteEventSource(source: NoteEventSource): Terminable {return this.#noteEventInstrument.setNoteEventSource(source)}

    get noteEventTarget(): Option<NoteEventTarget & DeviceProcessor> {return Option.wrap(this)}
    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}
    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get audioOutput(): AudioBuffer {return this.#audioOutput}
    get adapter(): SoundfontDeviceBoxAdapter {return this.#adapter}

    reset(): void {
        this.#noteEventInstrument.clear()
        this.#peakBroadcaster.clear()
        this.#voices.length = 0
        this.#audioOutput.clear()
        this.eventInput.clear()
    }

    handleEvent(event: Event): void {
        const optSoundfont = this.#loader.flatMap(loader => loader.soundfont)
        if (optSoundfont.isEmpty()) {return}
        const soundfont = optSoundfont.unwrap()
        if (NoteLifecycleEvent.isStart(event)) {
            const preset: Preset = soundfont.presets[this.#adapter.presetIndex] ?? soundfont.presets[0]
            if (isAbsent(preset)) {
                console.warn("No preset available")
                return
            }
            let voiceCount = 0
            for (const presetZone of preset.zones) {
                const velocityByte = Math.round(event.velocity * 127)
                if (this.#isMatching(event.pitch, velocityByte, presetZone)) {
                    const instrumentZones = presetZone.instrument.zones
                    for (let i = 0; i < instrumentZones.length; i++) {
                        const instZone = instrumentZones[i]
                        if (this.#isMatching(event.pitch, velocityByte, instZone)) {
                            this.#voices.push(new SoundfontVoice(event, presetZone, instZone, soundfont))
                            voiceCount++
                        }
                    }
                }
            }
        } else if (NoteLifecycleEvent.isStop(event)) {
            this.#voices.forEach(voice => {
                if (voice.event.id === event.id) {voice.release()}
            })
        }
    }

    processAudio(_block: Block, fromIndex: int, toIndex: int): void {
        this.#audioOutput.clear(fromIndex, toIndex)
        for (let index = this.#voices.length - 1; index >= 0; index--) {
            if (this.#voices[index].processAdd(this.#audioOutput, fromIndex, toIndex)) {
                this.#voices.splice(index, 1)
            }
        }
    }

    finishProcess(): void {
        this.#audioOutput.assertSanity()
        this.#peakBroadcaster.process(this.#audioOutput.getChannel(0), this.#audioOutput.getChannel(1))
    }

    toString(): string {return `{SoundfontDevice}`}

    #isMatching(pitch: byte, velocity: byte, zone: PresetZone | InstrumentZone): boolean {
        return this.#isInRange(zone.generators[GeneratorType.VelRange]?.range, velocity)
            && this.#isInRange(zone.generators[GeneratorType.KeyRange]?.range, pitch)

    }

    #isInRange(range: Optional<Range>, value: byte): boolean {
        return isUndefined(range) || (value >= range.lo && value <= range.hi)
    }
}
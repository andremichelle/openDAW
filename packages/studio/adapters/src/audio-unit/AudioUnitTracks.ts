import {AudioUnitBoxAdapter} from "./AudioUnitBoxAdapter"
import {BoxAdapters} from "../BoxAdapters"
import {FieldParameterTracks} from "../timeline/ParameterTracks"

export class AudioUnitTracks extends FieldParameterTracks {
    readonly #adapter: AudioUnitBoxAdapter

    constructor(adapter: AudioUnitBoxAdapter, boxAdapters: BoxAdapters) {
        super(adapter.box.graph, adapter.box.tracks, boxAdapters)
        this.#adapter = adapter
    }

    get audioUnitBox(): AudioUnitBoxAdapter["box"] {return this.#adapter.box}
}

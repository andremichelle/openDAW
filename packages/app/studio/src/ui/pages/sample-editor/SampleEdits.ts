import {Option} from "@opendaw/lib-std"
import {AudioData, AudioSplice} from "@opendaw/lib-dsp"
import {SampleDocument} from "./SampleDocument"

export namespace SampleEdits {
    export const copy = (document: SampleDocument): Option<AudioData> => {
        if (!document.hasSelection) {return Option.None}
        const {from, to} = document.selection.getValue()
        return Option.wrap(AudioSplice.slice(document.audio, from, to))
    }

    export const cut = (document: SampleDocument): Option<AudioData> => {
        const clip = copy(document)
        remove(document)
        return clip
    }

    export const remove = (document: SampleDocument): void => {
        if (!document.hasSelection) {return}
        const {from, to} = document.selection.getValue()
        document.replace(from, to - from, AudioSplice.empty(document.audio), {from, to: from})
    }

    export const canPaste = (document: SampleDocument, clip: AudioData): boolean =>
        clip.sampleRate === document.audio.sampleRate && clip.numberOfFrames > 0

    export const paste = (document: SampleDocument, clip: AudioData): void => {
        if (!canPaste(document, clip)) {return}
        const {from, to} = document.selection.getValue()
        const insert = AudioSplice.matchChannels(clip, document.audio.numberOfChannels)
        document.replace(from, to - from, insert, {from, to: from + insert.numberOfFrames})
    }

    export const crop = (document: SampleDocument): void => {
        if (!document.hasSelection) {return}
        const {from, to} = document.selection.getValue()
        const {numberOfFrames} = document.audio
        if (from === 0 && to === numberOfFrames) {return}
        document.replace(0, numberOfFrames, AudioSplice.slice(document.audio, from, to), {from: 0, to: to - from})
    }

    export const silence = (document: SampleDocument): void => {
        if (!document.hasSelection) {return}
        const {from, to} = document.selection.getValue()
        document.replace(from, to - from, AudioSplice.silence(document.audio, to - from), {from, to})
    }
}

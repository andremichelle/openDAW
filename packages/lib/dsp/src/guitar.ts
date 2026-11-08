import {int} from "@opendaw/lib-std"

// The twin of `fretting.rs` in device-guitar: the guitar test and the crate test share one parity table.
export namespace Guitar {
    export const Strings = 6
    export const Muted = -1

    export type Tab = ReadonlyArray<int>

    export const TuningNames: ReadonlyArray<string> = ["Standard", "Drop D", "Open G", "DADGAD"]
    export const Tunings: ReadonlyArray<ReadonlyArray<int>> = [
        [40, 45, 50, 55, 59, 64],
        [38, 45, 50, 55, 59, 64],
        [38, 43, 50, 55, 59, 62],
        [38, 45, 50, 55, 57, 62]
    ]
    export const PositionNames: ReadonlyArray<string> = ["Open", "3rd", "5th", "7th", "9th", "12th"]
    export const PositionFrets: ReadonlyArray<int> = [0, 3, 5, 7, 9, 12]

    const MaxOptions = 9
    const mod12 = (value: int): int => ((value % 12) + 12) % 12
    const trailingZeros = (value: int): int => 31 - Math.clz32(value & -value)

    type Search = {
        open: ReadonlyArray<int>, low: int, options: ReadonlyArray<ReadonlyArray<int>>,
        bass: int, required: int, tones: int, tab: Array<int>, best: Array<int>, bestScore: int, found: boolean
    }

    const evaluate = (search: Search): void => {
        const {tab, open, low} = search
        const first = tab.findIndex(fret => fret >= 0)
        if (first < 0) {return}
        let last = first
        for (let string = Strings - 1; string >= 0; string--) {
            if (tab[string] >= 0) {
                last = string
                break
            }
        }
        for (let string = first; string <= last; string++) {if (tab[string] < 0) {return}}
        const sounding = last - first + 1
        let toneCount = 0
        for (let bit = 0; bit < 12; bit++) {if ((search.tones & (1 << bit)) !== 0) {toneCount++}}
        if (sounding < Math.min(3, toneCount)) {return}
        if (mod12(open[first] + tab[first]) !== search.bass) {return}
        let classes = 0, lowest = Number.MAX_SAFE_INTEGER, highest = Number.MIN_SAFE_INTEGER, opens = 0
        for (let string = first; string <= last; string++) {
            const fret = tab[string]
            classes |= 1 << mod12(open[string] + fret)
            if (fret === 0) {
                opens++
            } else {
                lowest = Math.min(lowest, fret)
                highest = Math.max(highest, fret)
            }
        }
        if ((classes & search.required) !== search.required) {return}
        const fretted = lowest !== Number.MAX_SAFE_INTEGER
        const span = fretted ? highest - lowest : 0
        if (span > 3) {return}
        if (fretted) {
            let fingers = 1, fingered = 0, barreFrom = -1, barreTo = -1
            for (let string = first; string <= last; string++) {
                if (tab[string] > lowest) {fingers++}
                if (tab[string] === lowest) {
                    fingered++
                    if (barreFrom < 0) {barreFrom = string}
                    barreTo = string
                }
            }
            if (fingers > 4) {return}
            if (fingered > 1) {
                for (let string = barreFrom; string <= barreTo; string++) {if (tab[string] === 0) {return}}
            }
        }
        const anchor = fretted ? lowest : low
        const openScore = low === 0 ? opens * 2 : -opens * 3
        const score = sounding * 3 + openScore - Math.abs(anchor - Math.max(low, 1)) * 2 - span
        if (!search.found || score > search.bestScore) {
            search.found = true
            search.bestScore = score
            search.best = [...tab]
        }
    }

    const walk = (search: Search, string: int): void => {
        if (string === Strings) {
            evaluate(search)
            return
        }
        for (const option of search.options[string]) {
            search.tab[string] = option
            walk(search, string + 1)
        }
    }

    // One fret per string or Muted for the chord root with its voicing mask (the lowest bit is the bass).
    export const tab = (root: int, voicing: int, tuning: int, position: int): Tab => {
        const open = Tunings[Math.min(tuning, Tunings.length - 1)]
        const at = Math.min(position, PositionFrets.length - 1)
        let tones = 0
        for (let interval = 0; interval < 31; interval++) {
            if ((voicing & (1 << interval)) !== 0) {tones |= 1 << mod12(root + interval)}
        }
        if (tones === 0) {return new Array(Strings).fill(Muted)}
        const bass = mod12(root + trailingZeros(voicing))
        const rootClass = mod12(root)
        const fifth = mod12(root + 7)
        const withoutFifth = fifth !== bass ? tones & ~(1 << fifth) : tones
        const order = PositionFrets.map((_, index) => index)
            .sort((left, right) => (Math.abs(left - at) - Math.abs(right - at)) || left - right)
        for (const required of [tones, withoutFifth, (1 << bass) | (1 << rootClass)]) {
            for (const candidate of order) {
                const low = PositionFrets[candidate]
                const options = open.map(pitch => {
                    const list: Array<int> = [Muted]
                    for (let fret = Math.max(low - 1, 0); fret <= low + 4; fret++) {
                        if ((tones & (1 << mod12(pitch + fret))) !== 0 && list.length < MaxOptions) {list.push(fret)}
                    }
                    if (low > 1 && (tones & (1 << mod12(pitch))) !== 0 && list.length < MaxOptions) {list.push(0)}
                    return list
                })
                const search: Search = {
                    open, low, options, bass, required, tones, tab: new Array(Strings).fill(Muted),
                    best: new Array(Strings).fill(Muted), bestScore: 0, found: false
                }
                walk(search, 0)
                if (search.found) {return search.best}
            }
        }
        return new Array(Strings).fill(Muted)
    }

    export const pitch = (tuning: int, string: int, fret: int): int =>
        Tunings[Math.min(tuning, Tunings.length - 1)][string] + fret
}

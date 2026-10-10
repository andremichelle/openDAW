const SHARPS = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"]
const FLATS = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"]

export const tunerNoteName = (midi: number, spelling: number): string => {
    const rounded = Math.round(midi), index = ((rounded % 12) + 12) % 12
    const pitch = spelling === 1 ? FLATS[index]
        : spelling === 2 && SHARPS[index] !== FLATS[index] ? SHARPS[index] + "/" + FLATS[index] : SHARPS[index]
    // Match MidiKeys.toFullString, used by openDAW's piano roll.
    return pitch + (Math.floor(rounded / 12) - 2)
}

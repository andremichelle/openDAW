const SHARPS = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"]

export const tunerNoteName = (midi: number): string => {
    const rounded = Math.round(midi), index = ((rounded % 12) + 12) % 12
    return SHARPS[index] + (Math.floor(rounded / 12) - 2)
}

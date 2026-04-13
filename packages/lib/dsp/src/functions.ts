export const wavefold = (input: number): number => {
    const scaled = 0.25 * input + 0.25
    return 4.0 * (Math.abs(scaled - Math.floor(scaled + 0.5)) - 0.25)
}
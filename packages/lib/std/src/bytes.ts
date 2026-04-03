export namespace Bytes {
    const Units = ["B", "kB", "MB", "GB", "TB", "PB"] as const

    export const toString = (numBytes: number): string => {
        if (numBytes === 0) {return "0B"}
        const exponent = Math.min(Math.floor(Math.log(numBytes) / Math.log(1000)), Units.length - 1)
        const value = numBytes / Math.pow(1000, exponent)
        const formatted = exponent === 0 ? value.toString() : value.toFixed(value < 10 ? 1 : 0)
        return `${formatted}${Units[exponent]}`
    }
}
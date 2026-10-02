export const ClipWidth = 49 // make a better connection to the CSS variables and adjustable
export const MinRegionsWidth = 320

export const getClipColumnFit = (availableWidth: number): number =>
    Math.floor((availableWidth - MinRegionsWidth) / ClipWidth)

/** Center the 2:1 tuner artwork without independently stretching either axis. */
export const fitTunerCanvas = (width: number, height: number) => {
    const scale = Math.min(width / 480, height / 240)
    return {scale, x: (width - 480 * scale) / 2, y: (height - 240 * scale) / 2}
}

/** Map the cents scale to the display's inset edges, with zero fixed at center. */
export const tunerMeterX = (cents: number) => 240 + Math.max(-50, Math.min(50, cents)) * 4.44

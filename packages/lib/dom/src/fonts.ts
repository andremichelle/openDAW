export type FontFaceProperties = {
    "font-family": string
    "font-style": "normal" | "italic" | "oblique"
    "font-weight": 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 1000 | "normal" | "bold" | "bolder" | "lighter" | `${number} ${number}`
    "src": string
}

export const loadFont = async (properties: FontFaceProperties) => {
    try {
        const response = await fetch(properties.src, {credentials: "omit"})
        const fontData = await response.arrayBuffer()
        const fontFace = new FontFace(properties["font-family"], fontData, {
            display: "block",
            weight: String(properties["font-weight"]),
            style: properties["font-style"]
        })
        await fontFace.load()
        document.fonts.add(fontFace)
        console.debug(`font loaded '${fontFace.family} ${fontFace.style} ${fontFace.weight}'`)
    } catch (error) {
        console.error(error)
    }
}

// suggested by claude.ai to compensate variants on Mac/Windows
export const getFontSizeForHeight = (context: CanvasRenderingContext2D,
                                     fontFamily: string,
                                     fontSize: number): number => {
    context.font = `${fontSize}px ${fontFamily}, sans-serif`
    const metrics = context.measureText("M") // Use 'M' or your typical character
    const actualHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent
    return (fontSize / actualHeight) * fontSize
}
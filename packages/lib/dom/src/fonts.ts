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
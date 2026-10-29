import {Color} from "@opendaw/lib-std"

export const ColorSchemes = ["classic", "modern", "contrast"] as const

export type ColorScheme = typeof ColorSchemes[number]

export const DefaultColorScheme: ColorScheme = "classic"

type NeutralName = "bright" | "gray" | "dark" | "shadow" | "black" | "background" | "panelBackground"
    | "panelBackgroundBright" | "panelBackgroundDark" | "headerBackground" | "footerBackground"

type Neutral = readonly [saturation: number, lightness: number]

const NeutralHue = 197

const Neutrals: Record<ColorScheme, Record<NeutralName, Neutral>> = {
    classic: {
        bright: [5, 100], gray: [31, 91], dark: [15, 84], shadow: [10, 60], black: [10, 30],
        background: [8, 9], panelBackground: [14, 12], panelBackgroundBright: [13, 16], panelBackgroundDark: [14, 11],
        headerBackground: [14, 3], footerBackground: [14, 9]
    },
    modern: {
        bright: [0, 100], gray: [0, 70], dark: [0, 58], shadow: [0, 39], black: [0, 24],
        background: [0, 13], panelBackground: [0, 15], panelBackgroundBright: [0, 20], panelBackgroundDark: [0, 12],
        headerBackground: [0, 18], footerBackground: [0, 11]
    },
    contrast: {
        bright: [10, 100], gray: [10, 94], dark: [10, 88], shadow: [10, 73], black: [10, 50],
        background: [10, 19], panelBackground: [10, 21], panelBackgroundBright: [10, 29], panelBackgroundDark: [10, 19],
        headerBackground: [10, 10], footerBackground: [10, 10]
    }
}

let scheme: ColorScheme = DefaultColorScheme

const neutral = (name: NeutralName): Color => {
    const [saturation, lightness] = Neutrals[scheme][name]
    return new Color(NeutralHue, saturation, lightness)
}

export const Colors = {
    white: new Color(0, 0, 100),
    blue: new Color(189, 100, 65),
    green: new Color(150, 77, 69),
    yellow: new Color(60, 100, 84),
    cream: new Color(65, 37, 83),
    orange: new Color(31, 100, 73),
    red: new Color(354, 100, 65),
    purple: new Color(314, 100, 78),
    menuActive: new Color(210, 90, 40),
    get bright(): Color {return neutral("bright")},
    get gray(): Color {return neutral("gray")},
    get dark(): Color {return neutral("dark")},
    get shadow(): Color {return neutral("shadow")},
    get black(): Color {return neutral("black")},
    get background(): Color {return neutral("background")},
    get panelBackground(): Color {return neutral("panelBackground")},
    get panelBackgroundBright(): Color {return neutral("panelBackgroundBright")},
    get panelBackgroundDark(): Color {return neutral("panelBackgroundDark")},
    get headerBackground(): Color {return neutral("headerBackground")},
    get footerBackground(): Color {return neutral("footerBackground")}
}

export const setColorScheme = (value: ColorScheme): void => {scheme = value}

export const initializeColors = (root: { style: { setProperty: (name: string, value: string) => void } }) => {
    Object.entries(Colors).forEach(([name, value]) => {
        const cssName = name.replace(/([A-Z])/g, "-$1").toLowerCase()
        root.style.setProperty(`--color-${cssName}`, value.toString())
    })
}
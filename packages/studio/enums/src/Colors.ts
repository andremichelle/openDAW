import {Color, unitValue} from "@opendaw/lib-std"

export type ColorScheme = {hue: number, saturation: unitValue}

export const DefaultColorScheme: ColorScheme = {hue: 197, saturation: 1.0}

const scheme: ColorScheme = {...DefaultColorScheme}

const neutral = (saturation: number, lightness: number): Color =>
    new Color(scheme.hue, saturation * scheme.saturation, lightness)

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
    get bright(): Color {return neutral(5, 100)},
    get gray(): Color {return neutral(31, 91)},
    get dark(): Color {return neutral(15, 84)},
    get shadow(): Color {return neutral(10, 60)},
    get black(): Color {return neutral(10, 30)},
    get background(): Color {return neutral(8, 9)},
    get panelBackground(): Color {return neutral(14, 12)},
    get panelBackgroundBright(): Color {return neutral(13, 16)},
    get panelBackgroundDark(): Color {return neutral(14, 11)},
    get headerBackground(): Color {return neutral(14, 3)},
    get footerBackground(): Color {return neutral(14, 9)}
}

export const setColorScheme = ({hue, saturation}: ColorScheme): void => {
    scheme.hue = hue
    scheme.saturation = saturation
}

export const initializeColors = (root: { style: { setProperty: (name: string, value: string) => void } }) => {
    Object.entries(Colors).forEach(([name, value]) => {
        const cssName = name.replace(/([A-Z])/g, "-$1").toLowerCase()
        root.style.setProperty(`--color-${cssName}`, value.toString())
    })
}
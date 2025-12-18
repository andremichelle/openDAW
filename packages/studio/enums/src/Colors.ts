import {Color} from "@opendaw/lib-std"

export const Colors = {
    white: new Color(0, 0, 100),
    blue: new Color(189, 100, 65),
    green: new Color(150, 77, 69),
    yellow: new Color(60, 100, 84),
    cream: new Color(65, 20, 83),
    orange: new Color(31, 100, 73),
    red: new Color(354, 100, 65),
    purple: new Color(314, 100, 78),
    bright: new Color(197, 0, 100),
    gray: new Color(197, 31, 85),
    dark: new Color(197, 15, 57),
    shadow: new Color(197, 10, 38),
    black: new Color(197, 10, 16),
    background: new Color(197, 6, 7),
    panelBackground: new Color(197, 14, 9),
    panelBackgroundBright: new Color(197, 14, 13),
    panelBackgroundDark: new Color(197, 14, 10)
}

export const initializeColors = (root: { style: { setProperty: (name: string, value: string) => void } }) => {
    Object.entries(Colors).forEach(([name, value]) => {
        const cssName = name.replace(/([A-Z])/g, "-$1").toLowerCase()
        root.style.setProperty(`--color-${cssName}`, value.toString())
    })
}
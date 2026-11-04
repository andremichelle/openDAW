import {createElement} from "@opendaw/lib-jsx"
import {Colors} from "@opendaw/studio-enums"

const wave = "M-360 0 C-300 -1 -240 -1 -180 0 S-60 1 0 0 S120 -1 180 0 S300 1 360 0 S480 -1 540 0 S660 1 720 0 " +
    "S840 -1 900 0 S1020 1 1080 0 S1200 -1 1260 0 S1380 1 1440 0 S1560 -1 1620 0 S1740 1 1800 0"

const waves = (): ReadonlyArray<[number, number, number, string, number]> => [
    [0, 300, 70, Colors.blue.toString(), 0.55],
    [-90, 310, 48, Colors.blue.toString(), 0.3],
    [-180, 290, 96, Colors.purple.toString(), 0.35],
    [-270, 305, 30, Colors.orange.toString(), 0.5],
    [-45, 295, 120, Colors.gray.toString(), 0.12],
    [-135, 300, 16, Colors.green.toString(), 0.4]
]

const rings: ReadonlyArray<[number, number]> = [
    [36, 0.9], [72, 0.7], [112, 0.5], [156, 0.35], [204, 0.22], [256, 0.12], [312, 0.06]
]

export const ContestArt = () => (
    <svg classList="art" viewBox="0 0 1440 420" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
            <pattern id="contest-dots" width="24" height="24" patternUnits="userSpaceOnUse">
                <circle cx="2" cy="2" r="1" fill={Colors.black.toString()}/>
            </pattern>
            <radialGradient id="contest-glow" cx="80%" cy="38%" r="45%">
                <stop offset="0" stop-color={Colors.orange.toString()} stop-opacity="0.28"/>
                <stop offset="1" stop-color={Colors.orange.toString()} stop-opacity="0"/>
            </radialGradient>
            <radialGradient id="contest-glow-blue" cx="18%" cy="95%" r="40%">
                <stop offset="0" stop-color={Colors.blue.toString()} stop-opacity="0.18"/>
                <stop offset="1" stop-color={Colors.blue.toString()} stop-opacity="0"/>
            </radialGradient>
            <linearGradient id="contest-scrim" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stop-color={Colors.headerBackground.toString()} stop-opacity="0.92"/>
                <stop offset="0.45" stop-color={Colors.headerBackground.toString()} stop-opacity="0.75"/>
                <stop offset="0.7" stop-color={Colors.headerBackground.toString()} stop-opacity="0"/>
            </linearGradient>
        </defs>
        <rect width="1440" height="420" fill="url(#contest-dots)" opacity="0.45"/>
        <rect width="1440" height="420" fill="url(#contest-glow)"/>
        <rect width="1440" height="420" fill="url(#contest-glow-blue)"/>
        <g fill="none" stroke={Colors.orange.toString()} stroke-width="1.2">
            {rings.map(([radius, opacity]) => <circle cx="1150" cy="160" r={radius} opacity={opacity}/>)}
        </g>
        <g fill="none" stroke-width="1.5" stroke-linecap="round">
            {waves().map(([x, y, amplitude, color, opacity]) => (
                <path d={wave} transform={`translate(${x} ${y}) scale(1 ${amplitude})`}
                      stroke={color} opacity={opacity} vector-effect="non-scaling-stroke"/>
            ))}
        </g>
        <rect width="1440" height="420" fill="url(#contest-scrim)"/>
    </svg>
)

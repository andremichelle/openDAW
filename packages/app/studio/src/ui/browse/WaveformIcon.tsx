import {createElement} from "@opendaw/lib-jsx"

// Not `IconSymbol.Waveform`: that glyph is a wave inside a circle, which collapses into a coin at the size a
// browser row draws it. Bars stay readable there.
export const WaveformIcon = () => (
    <svg className="waveform" viewBox="0 0 24 24" fill="currentColor">
        <rect x="1" y="10" width="2" height="4" rx="1"/>
        <rect x="5" y="7" width="2" height="10" rx="1"/>
        <rect x="9" y="3" width="2" height="18" rx="1"/>
        <rect x="13" y="8" width="2" height="8" rx="1"/>
        <rect x="17" y="5" width="2" height="14" rx="1"/>
        <rect x="21" y="9" width="2" height="6" rx="1"/>
    </svg>
)

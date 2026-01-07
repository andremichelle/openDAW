import { Colors } from "@opendaw/studio-enums"

// OpenDAW premium palette
// Extending the standard Colors enum with specific shades needed for the new design
export const Palette = {
    zinc: {
        50: "#fafafa",
        100: "#f4f4f5",
        200: "#e4e4e7",
        300: "#d4d4d8",
        400: "#a1a1aa",
        500: "#71717a",
        600: "#52525b",
        700: "#3f3f46",
        800: "#27272a",
        900: "#18181b",
        950: "#09090b"
    },
    slate: {
        50: "#f8fafc",
        100: "#f1f5f9",
        200: "#e2e8f0",
        300: "#cbd5e1",
        400: "#94a3b8",
        500: "#64748b",
        600: "#475569",
        700: "#334155",
        800: "#1e293b",
        900: "#0f172a",
        950: "#020617"
    },
    // Semantics
    background: "#09090b", // zinc-950
    panel: "#18181b",      // zinc-900
    border: "#27272a",     // zinc-800
    text: {
        primary: "#ffffff",
        secondary: "#a1a1aa", // zinc-400
        muted: "#52525b"      // zinc-600
    },
    accent: Colors.blue.toString()
}

export const Spacing = {
    xs: "4px",
    sm: "8px",
    md: "16px",
    lg: "24px",
    xl: "32px",
    xxl: "48px"
}

export const Typography = {
    h1: { fontSize: "24px", fontWeight: "700", letterSpacing: "-0.5px" },
    h2: { fontSize: "20px", fontWeight: "600", letterSpacing: "-0.5px" },
    h3: { fontSize: "16px", fontWeight: "600" },
    body: { fontSize: "14px", lineHeight: "1.5" },
    small: { fontSize: "12px", color: Palette.text.secondary },
    tiny: { fontSize: "11px", textTransform: "uppercase", letterSpacing: "1px", fontWeight: "700" } as const
}

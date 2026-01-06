import { createElement } from "@opendaw/lib-jsx"
import { DefaultObservableValue, Terminator } from "@opendaw/lib-std"

// Re-reading OdieMetrics.tsx...
// const metricsStore: Box<MetricsData> = new Box({...})
// It subscribes to it.
// I will switch to `MutableObservableValue`.

import type { OdieService } from "./OdieService"

/**
 * OdieMetrics - Real-time Dashboard
 * 
 * Modern, dense, informative. No fluff.
 */

interface MetricsData {
    // Tests
    testsRun: number
    testsPassed: number
    lastTestTime: number | null

    // Performance
    avgResponseTime: number
    totalTokensIn: number
    totalTokensOut: number

    // API
    apiRotations: number
    apiErrors: number

    // Behavior
    totalToolCalls: number
    totalMessages: number
}

// Singleton metrics store
const metricsStore = new DefaultObservableValue<MetricsData>({
    testsRun: 0,
    testsPassed: 0,
    lastTestTime: null,
    avgResponseTime: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    apiRotations: 0,
    apiErrors: 0,
    totalToolCalls: 0,
    totalMessages: 0
})

// Export for other components to update
export const updateMetrics = (partial: Partial<MetricsData>) => {
    const current = metricsStore.getValue()
    metricsStore.setValue({ ...current, ...partial })
}

export const incrementMetric = (key: keyof MetricsData, amount: number = 1) => {
    const current = metricsStore.getValue()
    metricsStore.setValue({ ...current, [key]: (current[key] as number) + amount })
}

// Dashboard Component
export const OdieMetrics = ({ service }: { service: OdieService }) => {
    const lifecycle = new Terminator()

    // --- Stat Card ---
    const StatCard = ({ label, value, icon, color }: any) => (
        <div style={{
            background: "rgba(15, 23, 42, 0.6)",
            border: "1px solid rgba(255, 255, 255, 0.05)",
            borderRadius: "8px",
            padding: "12px 16px",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            minWidth: "140px"
        }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ fontSize: "14px" }}>{icon}</span>
                <span style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</span>
            </div>
            <span style={{ fontSize: "24px", fontWeight: "700", color: color || "#f8fafc" }}>{value}</span>
        </div>
    ) as HTMLElement

    // --- Dynamic Values ---
    const testScore = <span>-/-</span> as HTMLElement
    const testTime = <span>Never</span> as HTMLElement
    const respTime = <span>0ms</span> as HTMLElement
    const tokenUsage = <span>0</span> as HTMLElement
    const apiProvider = <span>-</span> as HTMLElement
    const apiRotations = <span>0</span> as HTMLElement
    const toolCalls = <span>0</span> as HTMLElement
    const messages = <span>0</span> as HTMLElement

    // --- Subscriptions ---
    lifecycle.own(metricsStore.subscribe(obs => {
        const m = obs.getValue()
        testScore.innerText = `${m.testsPassed}/${m.testsRun}`
        testTime.innerText = m.lastTestTime ? `${Math.round((Date.now() - m.lastTestTime) / 60000)}m ago` : "Never"
        respTime.innerText = `${m.avgResponseTime}ms`
        tokenUsage.innerText = `${Math.round((m.totalTokensIn + m.totalTokensOut) / 1000)}k`
        apiRotations.innerText = String(m.apiRotations)
        toolCalls.innerText = String(m.totalToolCalls)
        messages.innerText = String(m.totalMessages)
    }))

    lifecycle.own(service.activeModelName.subscribe(obs => {
        let name = obs.getValue()
        if (name.includes("gemini-3-flash")) name = "Gemini 3 Flash"
        else if (name.includes("gemini-2.5")) name = "Gemini 2.5"
        apiProvider.innerText = name
    }))

    // Track messages
    lifecycle.own(service.messages.subscribe(obs => {
        const msgs = obs.getValue()
        updateMetrics({ totalMessages: msgs.length })
    }))

    // --- Layout ---
    const dashboard = <div style={{
        background: "linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.95))",
        border: "1px solid rgba(255, 255, 255, 0.1)",
        borderRadius: "16px",
        padding: "20px",
        color: "#f8fafc",
        fontFamily: "system-ui, -apple-system, sans-serif"
    }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "20px" }}>📊</span>
                <span style={{ fontSize: "16px", fontWeight: "600" }}>ODIE METRICS</span>
            </div>
            {/* <div style={{ width: "24px" }} /> Placeholder for future actions */}
        </div>

        {/* Grid */}
        <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "12px"
        }}>
            {/* Row 1 */}
            <StatCard label="Tests" value={testScore} icon="✅" color="#10b981" />
            <StatCard label="Last Run" value={testTime} icon="🕐" color="#94a3b8" />
            <StatCard label="Avg Response" value={respTime} icon="⚡" color="#f59e0b" />
            <StatCard label="Tokens" value={tokenUsage} icon="📊" color="#8b5cf6" />

            {/* Row 2 */}
            <StatCard label="Provider" value={apiProvider} icon="🤖" color="#3b82f6" />
            <StatCard label="API Rotations" value={apiRotations} icon="🔄" color="#6366f1" />
            <StatCard label="Tool Calls" value={toolCalls} icon="🛠️" color="#ec4899" />
            <StatCard label="Messages" value={messages} icon="💬" color="#14b8a6" />
        </div>
    </div> as HTMLElement

    return dashboard
}

// Command to show dashboard
export const METRICS_COMMAND_HELP = `
/metrics - Show Odie Metrics Dashboard
`

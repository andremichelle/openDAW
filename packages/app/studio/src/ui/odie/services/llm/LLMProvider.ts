import { ObservableValue, Optional } from "@opendaw/lib-std"

// ═══════════════════════════════════════════════════════════════════════════════
// Tool Property Schema (JSON Schema subset for LLM tool definitions)
// ═══════════════════════════════════════════════════════════════════════════════

export type ToolPropertyType = "string" | "number" | "integer" | "boolean" | "array" | "object"

export interface ToolPropertyBase {
    type: ToolPropertyType
    description?: string
}

export interface ToolPropertyString extends ToolPropertyBase {
    type: "string"
    enum?: string[]
}

export interface ToolPropertyNumber extends ToolPropertyBase {
    type: "number" | "integer"
    minimum?: number
    maximum?: number
}

export interface ToolPropertyBoolean extends ToolPropertyBase {
    type: "boolean"
}

export interface ToolPropertyArray extends ToolPropertyBase {
    type: "array"
    items?: ToolProperty
}

export interface ToolPropertyObject extends ToolPropertyBase {
    type: "object"
    properties?: Record<string, ToolProperty>
    required?: string[]
}

export type ToolProperty =
    | ToolPropertyString
    | ToolPropertyNumber
    | ToolPropertyBoolean
    | ToolPropertyArray
    | ToolPropertyObject

// ═══════════════════════════════════════════════════════════════════════════════
// Tool Call Arguments (runtime values from LLM)
// ═══════════════════════════════════════════════════════════════════════════════

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type ToolCallArgs = Record<string, JsonValue>

// ═══════════════════════════════════════════════════════════════════════════════
// LLM Tool Definition
// ═══════════════════════════════════════════════════════════════════════════════

export interface LLMTool {
    name: string
    description: string
    parameters: {
        type: "object"
        properties: Record<string, ToolProperty>
        required?: string[]
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool Call (from LLM response)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ToolCall {
    id: string
    name: string
    arguments: ToolCallArgs
}

// ═══════════════════════════════════════════════════════════════════════════════
// Message Custom Data (provider-specific metadata)
// ═══════════════════════════════════════════════════════════════════════════════

export interface MessageCustomData {
    thoughtSignature?: string        // Gemini thought signature
    modelVersion?: string            // Model version used
    tokenCount?: number              // Token usage
    finishReason?: string            // Why generation stopped
    [key: string]: string | number | boolean | undefined  // Allow extension
}

// ═══════════════════════════════════════════════════════════════════════════════
// Chat Message
// ═══════════════════════════════════════════════════════════════════════════════

export interface Message {
    id: string
    role: "user" | "model" | "system" | "function"
    content: string
    thoughts?: string                // Internal monologue/reasoning
    tool_calls?: ToolCall[]          // If the model decided to call a tool
    name?: string                    // For function role
    timestamp: number
    audio?: string                   // Base64 encoded audio
    customData?: MessageCustomData   // Provider-specific data
}

// ═══════════════════════════════════════════════════════════════════════════════
// Streaming Context (passed to streamChat)
// ═══════════════════════════════════════════════════════════════════════════════

export interface StreamContext {
    systemPrompt?: string
    projectName?: Optional<string>
    focusArea?: string
    previousToolResults?: Array<{
        name: string
        result: string
        success: boolean
    }>
}

// ═══════════════════════════════════════════════════════════════════════════════
// Hardware Check Result
// ═══════════════════════════════════════════════════════════════════════════════

export interface HardwareCheckResult {
    ok: boolean
    message: string
    data?: {
        gpuAvailable?: boolean
        vramMB?: number
        recommendedModels?: string[]
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Provider Configuration
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProviderConfig {
    apiKey?: string
    keyLibrary?: string[]            // The Infinity Library
    baseUrl?: string
    modelId?: string
    forceAgentMode?: boolean         // Manual Override
    // Gemini 3 Spec
    thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
    mediaResolution?: 'low' | 'medium' | 'high' | 'ultra_high'
}

// ═══════════════════════════════════════════════════════════════════════════════
// Provider Status & Interaction
// ═══════════════════════════════════════════════════════════════════════════════

export interface KeyStatus {
    key: string
    status: 'ready' | 'exhausted' | 'invalid' | 'unknown'
    isActive: boolean
}

export interface ProviderWithKeyStatuses {
    getKeyStatuses(): KeyStatus[]
}

// ═══════════════════════════════════════════════════════════════════════════════
// LLM Provider Interface
// ═══════════════════════════════════════════════════════════════════════════════

export interface LLMProvider {
    readonly id: string
    readonly manifest: {
        name: string
        description: string
        icon?: string                // Emoji or svg path
        getKeyUrl?: string           // Direct link to get key
        docsUrl?: string
    }
    requiresKey: boolean
    requiresUrl: boolean
    debugLog?: string                // Diagnostic output
    configure(config: ProviderConfig): void
    streamChat(
        messages: Message[],
        context?: StreamContext,
        tools?: LLMTool[],
        onFinal?: (msg: Message) => void,
        onStatusChange?: (status: string, model?: string) => void
    ): ObservableValue<{ content: string, thoughts?: string }>
    fetchModels?(): Promise<string[]>
    validate?(): Promise<{ ok: boolean, message: string }>
    checkHardwareFit?(): Promise<HardwareCheckResult>
}


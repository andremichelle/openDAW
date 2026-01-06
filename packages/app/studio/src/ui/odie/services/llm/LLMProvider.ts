import { ObservableValue } from "@opendaw/lib-std"

// -- TOOLING INTERFACES (The Nervous System) --

export interface LLMTool {
    name: string
    description: string
    parameters: {
        type: "object"
        properties: Record<string, any>
        required?: string[]
    }
}

export interface ToolCall {
    id: string
    name: string
    arguments: any // Parsed JSON
}

export interface Message {
    id: string
    role: "user" | "model" | "system" | "function"
    content: string
    tool_calls?: ToolCall[] // If the model decided to call a tool
    name?: string // For function role
    timestamp: number
    audio?: string // Base64 encoded audio
    customData?: Record<string, any> // Provider-specific data (e.g. Gemini Thought Signatures)
}

export interface ProviderConfig {
    apiKey?: string
    keyLibrary?: string[] // The Infinity Library
    baseUrl?: string
    modelId?: string
    forceAgentMode?: boolean // Manual Override
    // [Gemini 3 Spec]
    thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
    mediaResolution?: 'low' | 'medium' | 'high' | 'ultra_high'
}

export interface LLMProvider {
    readonly id: string
    // White Glove Manifest
    readonly manifest: {
        name: string
        description: string
        icon?: string // emoji or svg path
        getKeyUrl?: string // Direct link to get key
        docsUrl?: string
    }

    // Returns true if this provider needs an API Key
    requiresKey: boolean

    // Returns true if this provider needs a Base URL (e.g. Local)
    requiresUrl: boolean
    debugLog?: string // New field for diagnostic output

    // Configure the provider with user secrets/settings
    configure(config: ProviderConfig): void

    // Stream the chat response
    // Updated to support Tools (optional) and onFinal callback
    streamChat(
        messages: Message[],
        context?: any,
        tools?: LLMTool[],
        onFinal?: (msg: Message) => void, // Called when stream completes with full message
        onStatusChange?: (status: string, model?: string) => void // Meta-Events
    ): ObservableValue<string>

    // Optional: Fetch list of available models (for Local AI / OpenRouter)
    fetchModels?(): Promise<string[]>

    // Optional: Validate credentials/connection
    validate?(): Promise<{ ok: boolean, message: string }>
}

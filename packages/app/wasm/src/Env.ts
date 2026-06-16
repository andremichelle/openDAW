// Per-page service passed by the Router. Empty for now; grows as tests need shared state.
export type Env = Record<string, never>

export const env: Env = {}

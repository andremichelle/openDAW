// Used by Vite in disabled builds, so model code and its worker never enter the module graph.
const disabled = async (): Promise<void> => {throw new Error("MuScriptor is disabled in this build")}
export const MuScriptorTranscription = {browse: disabled, run: disabled}

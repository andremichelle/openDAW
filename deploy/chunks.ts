export type DistFile = { path: string, size: number }

// groups files in order into chunks of at most `limit` bytes and `maxFiles` files, a larger file goes alone
export const chunkFiles = (files: ReadonlyArray<DistFile>, limit: number, maxFiles: number = Infinity): Array<Array<string>> => {
    const chunks: Array<Array<string>> = []
    let current: Array<string> = []
    let bytes = 0
    for (const {path, size} of files) {
        if (current.length > 0 && (bytes + size > limit || current.length >= maxFiles)) {
            chunks.push(current)
            current = []
            bytes = 0
        }
        current.push(path)
        bytes += size
    }
    if (current.length > 0) {chunks.push(current)}
    return chunks
}

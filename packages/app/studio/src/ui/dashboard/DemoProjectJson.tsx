export type DemoProjectJson = {
    metadata: {
        name: string
        artist: string
        description: string
        tags: Array<string>
        created: string
        modified: string
        coverMimeType?: string
    }
    hasCover: boolean
    id: string
}
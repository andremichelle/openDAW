export class GraphValidationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "GraphValidationError"
    }
}

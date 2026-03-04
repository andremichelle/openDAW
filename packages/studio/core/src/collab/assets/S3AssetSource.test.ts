import {describe, expect, it} from "vitest"
import {S3AssetSource} from "./S3AssetSource"
import {S3Config} from "../types"

describe("S3AssetSource", () => {
    const config: S3Config = {
        bucket: "my-bucket",
        region: "us-east-1",
        accessKeyId: "AKIA...",
        secretAccessKey: "secret",
    }
    it("constructs the correct S3 URL for an asset", () => {
        const source = new S3AssetSource(config)
        expect(source.getUrl("asset-123")).toBe(
            "https://my-bucket.s3.us-east-1.amazonaws.com/opendaw/assets/asset-123"
        )
    })
    it("uses custom endpoint when provided", () => {
        const customConfig: S3Config = {...config, endpoint: "https://minio.local:9000"}
        const source = new S3AssetSource(customConfig)
        expect(source.getUrl("asset-123")).toBe(
            "https://minio.local:9000/my-bucket/opendaw/assets/asset-123"
        )
    })
    it("has name 's3'", () => {
        const source = new S3AssetSource(config)
        expect(source.name).toBe("s3")
    })
})

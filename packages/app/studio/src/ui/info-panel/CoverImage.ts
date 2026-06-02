import {isDefined, panic} from "@opendaw/lib-std"

export const CoverMaxSize = 1600

/**
 * Decodes the given image, fits it within a {@link CoverMaxSize}×{@link CoverMaxSize} box (never upscales)
 * and re-encodes it as WebP. Rejects if the source is not a decodable image.
 */
export const encodeCover = async (source: ArrayBuffer): Promise<ArrayBuffer> => {
    const bitmap = await createImageBitmap(new Blob([source]))
    const scale = Math.min(1, CoverMaxSize / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext("2d")
    if (!isDefined(context)) {
        bitmap.close()
        return panic("Could not acquire 2d context")
    }
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const blob = await canvas.convertToBlob({type: "image/webp", quality: 0.9})
    return blob.arrayBuffer()
}

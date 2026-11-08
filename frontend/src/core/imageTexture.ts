// An image a USD material names, decoded for use as a map.
//
// A material can state a picture as well as a colour (UsdPreviewSurface's UsdUVTexture), and a
// room's slab does: it is concrete, not a flat grey. The file arrives over the same transport the
// meshes do, so all that is left is to turn the bytes into a texture and tile it -- the shapes
// that want one are big flat things, and a single 256-pixel tile stretched over eighteen metres
// of floor is a blur, not a surface.
import * as THREE from "three"
const IMAGE_SUFFIXES = [".png", ".jpg", ".jpeg", ".webp"]
/** Whether this file is a picture rather than geometry (the uri may carry a `?hash=`). */
export function isImage(uri: string): boolean {
    const path = uri.split("?")[0].toLowerCase()
    return IMAGE_SUFFIXES.some((suffix) => path.endsWith(suffix))
}

/** Decoded off the main thread where the browser allows it; the fallback keeps older ones working. */
export async function imageTexture(data: Uint8Array, uri: string): Promise<THREE.Texture> {
    const blob = new Blob([data as unknown as BlobPart])
    const texture = typeof createImageBitmap === "function"
        ? new THREE.Texture(
            await createImageBitmap(blob, { imageOrientation: "flipY" }),
        )
        : await viaElement(blob)
    texture.name = uri
    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.anisotropy = 4
    texture.needsUpdate = true
    return texture
}

function viaElement(blob: Blob): Promise<THREE.Texture> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob)
        const image = new Image()
        image.onload = () => {
            URL.revokeObjectURL(url)
            resolve(new THREE.Texture(image))
        }
        image.onerror = () => {
            URL.revokeObjectURL(url)
            reject(new Error("the image could not be decoded"))
        }
        image.src = url
    })
}

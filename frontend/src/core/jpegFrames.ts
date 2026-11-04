// A camera's pictures straight from its JPEG topic, for when the browser can't read the live video back (Firefox on Android
// hands out no pixels of a hardware-decoded stream: drawImage gives transparent, WebGL a flat purple). Snapshots and
// undistort use these instead of the <video>.
import type { Connection, Topic } from "./transport.ts"
import { decode } from "./lcm/lcm.ts"

/** whether this video's pixels can be read (a real frame is opaque, even a black one); null until it has a frame */
export function videoReadable(video: HTMLVideoElement): boolean | null {
    if (!video.videoWidth) {
        return null
    }
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const context = canvas.getContext("2d", { willReadFrequently: true })!
    try {
        context.drawImage(video, 0, 0, 1, 1)
        return context.getImageData(0, 0, 1, 1).data[3] > 0
    } catch {
        return false
    }
}

/** a topic this file can take pictures from */
export const hasJpegFrames = (topic: Topic | null) => topic?.type === "sensor_msgs.CompressedImage"

const toBitmap = (bytes: Uint8Array) => {
    const message = decode("sensor_msgs.CompressedImage", bytes) as { format: string; data: Uint8Array }
    return createImageBitmap(new Blob([message.data as BlobPart], { type: /png/i.test(message.format) ? "image/png" : "image/jpeg" }))
}

/** Each picture of a CompressedImage topic, decoded, at most `hz` a second (raw bytes on the data channel); returns the stop. */
export function jpegFrames(connection: Connection, topic: Topic, hz: number, onFrame: (bitmap: ImageBitmap) => void): () => void {
    let decoding = false
    let stopped = false
    const handle = connection.subscribe(topic.key, { delivery: "latest", maxHz: hz }, (message) => {
        // one decode at a time: a slow phone drops pictures instead of queueing them
        if (decoding || stopped || !message.bytes) {
            return
        }
        decoding = true
        toBitmap(message.bytes).then((bitmap) => stopped ? bitmap.close() : onFrame(bitmap), (error) => console.warn("jpeg frame:", error)).finally(() => decoding = false)
    })
    return () => {
        stopped = true
        handle()
    }
}

/** The topic's next picture (a snapshot's), or an error after `timeoutMs`. */
export function nextJpegFrame(connection: Connection, topic: Topic, timeoutMs = 5000): Promise<ImageBitmap> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            stop()
            reject(new Error("no picture from the camera topic"))
        }, timeoutMs)
        const stop = jpegFrames(connection, topic, 5, (bitmap) => {
            clearTimeout(timer)
            stop()
            resolve(bitmap)
        })
    })
}

// Camera streams, shared: a panel and the 3D projection of the same topic use one bridge subscription.
// Color images arrive as the bridge's H.264 track, sized and paced by the viewer's latency/quality preset (core/videoQuality.ts); depth arrives lossless as fields (16UC1 mm / 32FC1 m).
import { Store } from "./store.ts"
import type { Connection, Topic } from "./transport.ts"
import { loadQuality, presetFor, saveQuality, type VideoQuality } from "./videoQuality.ts"

export interface VideoState {
    stream: MediaStream | null
    width: number
    height: number
    /** frames per second the bridge is sending */
    fps: number
}

export interface DepthImage {
    width: number
    height: number
    encoding: string
    data: Uint16Array | Float32Array | Uint8Array
}

export const isDepthTopic = (topic: Topic) => /depth/i.test(topic.name)

interface Source {
    users: number
    stop: () => void
    video: Store<VideoState>
    depth: Store<{ image: DepthImage | null }>
    /** this viewer's latency/quality preset (core/videoQuality.ts): the bridge's size / bitrate / rate */
    quality: Store<{ quality: VideoQuality }>
    /** a playing element for textures (the 3D projection), made on first use */
    element: HTMLVideoElement | null
}

export class VideoSources {
    #sources = new Map<string, Source>()
    constructor(readonly connection: Connection) {}

    acquire(topic: Topic): Source {
        let source = this.#sources.get(topic.key)
        if (source) {
            source.users++
            return source
        }
        const video = new Store<VideoState>({ stream: null, width: 0, height: 0, fps: 0 })
        const depth = new Store<{ image: DepthImage | null }>({ image: null })
        const quality = new Store<{ quality: VideoQuality }>({ quality: isDepthTopic(topic) ? "balanced" : loadQuality(topic.key) })
        source = { users: 1, stop: () => {}, video, depth, quality, element: null }
        this.#open(topic, source)
        this.#sources.set(topic.key, source)
        return source
    }

    /** Subscribes with the source's quality preset (color) or the lossless depth encoding. */
    #open(topic: Topic, source: Source) {
        const { video, depth } = source
        const prefix = topic.type === "sensor_msgs.CompressedImage" ? "dimos_lcm_compressed_" : "dimos_lcm_"
        let frames = 0
        let since = performance.now()
        source.stop = isDepthTopic(topic)
            ? this.connection.subscribe(topic.key, { delivery: "latest", maxHz: 15, encoding: `${prefix}depth` }, (message) => {
                if (message.decoded) {
                    depth.set({ image: message.decoded as DepthImage })
                }
            })
            : this.connection.subscribe(topic.key, { delivery: "latest", ...presetFor(source.quality.get().quality).options, encoding: `${prefix}image` }, (message) => {
                frames++
                const now = performance.now()
                const state = video.get()
                const width = message.video?.width ?? state.width
                const height = message.video?.height ?? state.height
                let fps = state.fps
                if (now - since > 1000) {
                    fps = Math.round((frames * 1000) / (now - since))
                    frames = 0
                    since = now
                }
                if (message.mediaStream !== state.stream || width !== state.width || height !== state.height || fps !== state.fps) {
                    video.set({ stream: message.mediaStream ?? state.stream, width, height, fps })
                }
            })
    }

    /** Another quality preset for a color topic: saved for this viewer, and the bridge subscription reopened with it. */
    setQuality(topic: Topic, quality: VideoQuality) {
        saveQuality(topic.key, quality)
        const source = this.#sources.get(topic.key)
        if (!source || isDepthTopic(topic) || source.quality.get().quality === quality) {
            return
        }
        source.quality.set({ quality })
        // open before closing: the old subscription still holds its transceiver, so the new one gets another (the
        // gateway frees a track only once its send loop ends; one handed straight back was "in use" and never showed)
        const stopOld = source.stop
        this.#open(topic, source)
        stopOld()
    }

    /** A muted, playing <video> of the stream (not in the document), for VideoTexture. */
    element(source: Source): HTMLVideoElement {
        if (!source.element) {
            const element = document.createElement("video")
            element.muted = true
            element.playsInline = true
            element.autoplay = true
            // attributes, not properties: Firefox honors the attribute but has no disablePictureInPicture property
            element.setAttribute("disablepictureinpicture", "")
            element.setAttribute("disableremoteplayback", "")
            const attach = () => {
                const stream = source.video.get().stream
                if (stream && element.srcObject !== stream) {
                    element.srcObject = stream
                    element.play().catch(() => {})
                }
            }
            source.video.subscribe(attach)
            attach()
            source.element = element
        }
        return source.element
    }

    release(topic: Topic) {
        const source = this.#sources.get(topic.key)
        if (!source || --source.users > 0) {
            return
        }
        source.stop()
        source.element?.pause()
        if (source.element) {
            source.element.srcObject = null
        }
        this.#sources.delete(topic.key)
    }
}

/** The CameraInfo topic for an image topic: the one sharing the longest leading part of the name. */
export function cameraInfoFor(image: Topic, topics: Topic[], overrides: Record<string, string> = {}): Topic | null {
    const infos = topics.filter((topic) => topic.type === "sensor_msgs.CameraInfo")
    const wanted = overrides[image.name]
    if (wanted) {
        return infos.find((topic) => topic.name === wanted) ?? null
    }
    const parts = image.name.split("/")
    let best: Topic | null = null
    let bestScore = -1
    for (const info of infos) {
        const other = info.name.split("/")
        let shared = 0
        while (shared < Math.min(parts.length, other.length) - 1 && parts[shared] === other[shared]) {
            shared++
        }
        // "color" in both names breaks ties (color_image ↔ color_camera_info over depth_camera_info)
        const score = shared * 10 + (/color|rgb/i.test(image.name) === /color|rgb/i.test(info.name) ? 1 : 0)
        if (score > bestScore) {
            best = info
            bestScore = score
        }
    }
    return best
}

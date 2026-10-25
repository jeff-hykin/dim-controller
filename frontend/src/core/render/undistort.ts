// A camera's picture undistorted on the GPU, as cv2.undistort does with the same K: each output pixel's ray goes through the
// lens model (CameraInfo D: plumb_bob, rational_polynomial or equidistant) to the source pixel it samples; what falls past the
// source's edge is transparent. The source can be scaled from the CameraInfo's size (a video stream sent smaller).
import type { CameraModel } from "dimos-react/three"
import type { Topic } from "../transport.ts"
import { cameraInfoFor } from "../video.ts"

export class UndistortCanvas {
    #gl: WebGL2RenderingContext
    #program: WebGLProgram
    #texture: WebGLTexture

    constructor(readonly canvas: HTMLCanvasElement) {
        const gl = canvas.getContext("webgl2", { premultipliedAlpha: false })
        if (!gl) {
            throw new Error("WebGL2 is not available")
        }
        this.#gl = gl
        const compile = (type: number, source: string) => {
            const shader = gl.createShader(type)!
            gl.shaderSource(shader, source)
            gl.compileShader(shader)
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                throw new Error(gl.getShaderInfoLog(shader) ?? "shader")
            }
            return shader
        }
        const program = gl.createProgram()!
        gl.attachShader(program, compile(gl.VERTEX_SHADER, `#version 300 es
            out vec2 uv;
            void main() {
                vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
                uv = vec2(corner.x, 1.0 - corner.y);
                gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
            }`))
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `#version 300 es
            precision highp float;
            in vec2 uv;
            out vec4 color;
            uniform sampler2D image;
            uniform vec4 K;
            uniform float D[8];
            uniform int equidistant;
            uniform vec2 size;
            void main() {
                // uv is top-down: (0, 0) the picture's top-left, in the CameraInfo's pixels
                vec2 ray = (uv * size - K.zw) / K.xy;
                vec2 distorted;
                if (equidistant == 1) {
                    float r = length(ray);
                    float theta = atan(r);
                    float t2 = theta * theta;
                    float thetaD = theta * (1.0 + t2 * (D[0] + t2 * (D[1] + t2 * (D[2] + t2 * D[3]))));
                    distorted = ray * (r > 1e-12 ? thetaD / r : 1.0);
                } else {
                    float x = ray.x, y = ray.y, r2 = x * x + y * y;
                    float radial = (1.0 + r2 * (D[0] + r2 * (D[1] + r2 * D[4]))) / (1.0 + r2 * (D[5] + r2 * (D[6] + r2 * D[7])));
                    distorted = vec2(x * radial + 2.0 * D[2] * x * y + D[3] * (r2 + 2.0 * x * x), y * radial + D[2] * (r2 + 2.0 * y * y) + 2.0 * D[3] * x * y);
                }
                vec2 source = (distorted * K.xy + K.zw) / size;
                if (any(lessThan(source, vec2(0.0))) || any(greaterThan(source, vec2(1.0)))) {
                    color = vec4(0.0);
                    return;
                }
                color = texture(image, source);
            }`))
        gl.linkProgram(program)
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(program) ?? "program")
        }
        this.#program = program
        this.#texture = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, this.#texture)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }

    /** Draws one picture (a playing video or a canvas) undistorted, at the source's own size. */
    draw(source: HTMLVideoElement | HTMLCanvasElement, model: CameraModel) {
        const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width
        const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height
        if (!width || !height) {
            return
        }
        const gl = this.#gl
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width
            this.canvas.height = height
        }
        gl.viewport(0, 0, width, height)
        gl.bindTexture(gl.TEXTURE_2D, this.#texture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
        gl.useProgram(this.#program)
        const uniform = (name: string) => gl.getUniformLocation(this.#program, name)
        gl.uniform1i(uniform("image"), 0)
        gl.uniform4f(uniform("K"), ...model.K)
        gl.uniform1fv(uniform("D"), model.D)
        gl.uniform1i(uniform("equidistant"), model.equidistant ? 1 : 0)
        gl.uniform2f(uniform("size"), model.width, model.height)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    dispose() {
        this.#gl.deleteTexture(this.#texture)
        this.#gl.deleteProgram(this.#program)
    }
}

/** The CameraInfo an image is undistorted with: the one picked by hand, else `<image>_info` (/depth_image → /depth_image_info),
 * else the nearest-named camera_info (cameraInfoFor, with the profile's own picks). */
export function undistortInfoFor(image: Topic, topics: Topic[], picked: string | undefined, profileInfos: Record<string, string>): Topic | null {
    const infos = topics.filter((topic) => topic.type === "sensor_msgs.CameraInfo")
    if (picked) {
        return infos.find((topic) => topic.name === picked) ?? null
    }
    return infos.find((topic) => topic.name === `${image.name}_info`) ?? cameraInfoFor(image, infos, profileInfos)
}

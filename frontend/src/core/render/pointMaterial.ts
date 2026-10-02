// One shader for every point-like thing. Points are GL point sprites, never meshes: "disc" shades each sprite as a
// small sphere, "square" is flat, and "voxel" snaps the point to a world grid and ray-casts an axis-aligned cube
// inside the sprite (with the cube's true depth written), so a voxel map looks like cubes for the cost of points.
// Coloring (gradient lookup by height / intensity / range) happens on the GPU too, so restyling costs nothing.
import * as THREE from "three"
import { gradientTexture } from "./gradients.ts"

export type PointStyle = "disc" | "square" | "voxel"
export type ColorMode = "height" | "intensity" | "range" | "solid"

export interface PointLook {
    style: PointStyle
    /** meters: the point's diameter, or the voxel's edge */
    size: number
    colorMode: ColorMode
    gradient: string
    /** for "height": which axis of the fixed frame */
    axis: 0 | 1 | 2
    /** null = auto from the data */
    rangeMin: number | null
    rangeMax: number | null
    solid: string
    opacity: number
}

const STYLE = { disc: 0, square: 1, voxel: 2 }
const COLOR = { height: 0, intensity: 1, range: 2, solid: 3 }

const vertexShader = /* glsl */ `
uniform float uSize;
uniform float uPxPerMeter;
uniform float uMinPx;
uniform int uStyle;
uniform int uColorMode;
uniform int uAxis;
uniform vec2 uRange;
uniform vec3 uSolid;
uniform vec3 uSensor;
uniform float uNow;
uniform float uWindow;
uniform sampler2D uGradient;
attribute float aTime;
attribute float aIntensity;
varying vec3 vColor;
varying vec3 vCenter;
varying float vHalf;

void main() {
    if (uWindow >= 0.0 && aTime < uNow - uWindow) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
    }
    vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
    vec3 center = uStyle == 2 ? (floor(world / uSize) + 0.5) * uSize : world;
    float value = uColorMode == 1 ? aIntensity : uColorMode == 2 ? distance(world, uSensor) : center[uAxis];
    float t = clamp((value - uRange.x) / max(1e-6, uRange.y - uRange.x), 0.0, 1.0);
    vColor = uColorMode == 3 ? uSolid : texture2D(uGradient, vec2(t, 0.5)).rgb;
    vec4 mv = viewMatrix * vec4(center, 1.0);
    gl_Position = projectionMatrix * mv;
    float depth = max(1e-3, -mv.z);
    // a cube's silhouette can reach sqrt(3)/2 of its edge from the center
    float px = uSize * uPxPerMeter / depth * (uStyle == 2 ? 1.8 : 1.0);
    gl_PointSize = clamp(px, uMinPx, 512.0);
    vCenter = center;
    vHalf = 0.5 * gl_PointSize / uPxPerMeter * depth;
}
`

const fragmentShader = /* glsl */ `
uniform float uSize;
uniform int uStyle;
uniform float uOpacity;
varying vec3 vColor;
varying vec3 vCenter;
varying float vHalf;

void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    p.y = -p.y;
#ifndef VOXEL
    // disc / square never write depth themselves, so the GPU's early depth test keeps working for them
    if (uStyle == 1) {
        gl_FragColor = vec4(vColor, uOpacity);
        return;
    }
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    gl_FragColor = vec4(vColor * (0.62 + 0.38 * sqrt(1.0 - r2)), uOpacity);
#else
    // voxel: cast this fragment's camera ray at the cube around vCenter
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 onSprite = vCenter + right * p.x * vHalf + up * p.y * vHalf;
    vec3 dir = normalize(onSprite - cameraPosition);
    vec3 h = vec3(0.5 * uSize);
    vec3 inv = 1.0 / dir;
    vec3 t0 = (vCenter - h - cameraPosition) * inv;
    vec3 t1 = (vCenter + h - cameraPosition) * inv;
    vec3 tMin = min(t0, t1);
    vec3 tMax = max(t0, t1);
    float tNear = max(max(tMin.x, tMin.y), tMin.z);
    float tFar = min(min(tMax.x, tMax.y), tMax.z);
    if (tNear > tFar || tFar < 0.0) discard;
    vec3 hit = cameraPosition + dir * tNear;
    vec3 local = (hit - vCenter) / h;
    vec3 a = abs(local);
    vec3 normal;
    vec2 face;
    if (a.x >= a.y && a.x >= a.z) { normal = vec3(sign(local.x), 0.0, 0.0); face = local.yz; }
    else if (a.y >= a.z) { normal = vec3(0.0, sign(local.y), 0.0); face = local.xz; }
    else { normal = vec3(0.0, 0.0, sign(local.z)); face = local.xy; }
    float light = 0.5 + 0.32 * max(dot(normal, normalize(vec3(0.35, 0.55, 1.0))), 0.0) + (normal.z > 0.5 ? 0.18 : 0.0);
    float edge = smoothstep(0.8, 0.98, max(abs(face.x), abs(face.y)));
    vec4 clip = projectionMatrix * viewMatrix * vec4(hit, 1.0);
    gl_FragDepthEXT = 0.5 * clip.z / clip.w + 0.5;
    gl_FragColor = vec4(vColor * light * (1.0 - 0.28 * edge), uOpacity);
#endif
}
`

export function makePointMaterial(pixelsPerMeter: { value: number }): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
            uSize: { value: 0.05 },
            uPxPerMeter: pixelsPerMeter,
            uMinPx: { value: 1.5 },
            uStyle: { value: 0 },
            uColorMode: { value: 0 },
            uAxis: { value: 2 },
            uRange: { value: new THREE.Vector2(0, 2) },
            uSolid: { value: new THREE.Color(0xffffff) },
            uSensor: { value: new THREE.Vector3() },
            uNow: { value: 0 },
            uWindow: { value: -1 },
            uOpacity: { value: 1 },
            uGradient: { value: gradientTexture("turbo") },
        },
        defines: {},
    })
    // three compiles this as GLSL 3 (WebGL2) and maps gl_FragColor / gl_FragDepthEXT / texture2D onto it
    return material
}

/** Pushes a look into the material's uniforms; `range` is the resolved [min, max] when the look's is auto. */
export function applyLook(material: THREE.ShaderMaterial, look: PointLook, range: [number, number]) {
    const uniforms = material.uniforms
    uniforms.uSize.value = Math.max(0.001, look.size)
    uniforms.uStyle.value = STYLE[look.style]
    const voxel = look.style === "voxel"
    if (voxel !== ("VOXEL" in material.defines)) {
        if (voxel) {
            material.defines.VOXEL = 1
        } else {
            delete material.defines.VOXEL
        }
        material.needsUpdate = true
    }
    uniforms.uColorMode.value = COLOR[look.colorMode]
    uniforms.uAxis.value = look.axis
    uniforms.uRange.value.set(look.rangeMin ?? range[0], look.rangeMax ?? range[1])
    uniforms.uSolid.value.set(look.solid)
    uniforms.uOpacity.value = look.opacity
    uniforms.uGradient.value = gradientTexture(look.gradient)
    material.transparent = look.opacity < 1
    material.depthWrite = look.opacity >= 1
}

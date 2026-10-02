// Regenerates frontend/src/core/lcm/schemas.json from dimos_lcm's .lcm files, so the viewer decodes any dimos
// message without a network import. Usage: deno run -A tools/gen_lcm_schemas.ts <dimos_lcm/lcm_files dir>
import { fromFileUrl, join } from "jsr:@std/path@1"

type Field = { name: string; type: string; dims: (number | string)[] }

const sourceDir = Deno.args[0]
if (!sourceDir) {
    console.error("usage: gen_lcm_schemas.ts <path to dimos_lcm/lcm_files>")
    Deno.exit(1)
}
const primitives = new Set(["int8_t", "int16_t", "int32_t", "int64_t", "byte", "float", "double", "string", "boolean"])
const schemas: Record<string, Field[]> = {}
for (const entry of [...Deno.readDirSync(sourceDir)].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".lcm")) {
        continue
    }
    const text = Deno.readTextFileSync(join(sourceDir, entry.name)).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
    const pkg = text.match(/package\s+(\w+)\s*;/)?.[1] ?? ""
    for (const struct of text.matchAll(/struct\s+(\w+)\s*\{([\s\S]*?)\}/g)) {
        const fields: Field[] = []
        for (const rawLine of struct[2].split(";")) {
            const line = rawLine.trim()
            if (!line || line.startsWith("const ")) {
                continue
            }
            const match = line.match(/^([\w.]+)\s+(\w+)((?:\s*\[\s*\w+\s*\])*)$/)
            if (!match) {
                throw new Error(`${entry.name}: cannot parse "${line}"`)
            }
            let type = match[1]
            if (!primitives.has(type) && !type.includes(".")) {
                type = `${pkg}.${type}`
            }
            const dims = [...match[3].matchAll(/\[\s*(\w+)\s*\]/g)].map((dim) => /^\d+$/.test(dim[1]) ? Number(dim[1]) : dim[1])
            fields.push({ name: match[2], type, dims })
        }
        schemas[`${pkg}.${struct[1]}`] = fields
    }
}
const out = join(fromFileUrl(new URL("..", import.meta.url)), "frontend/src/core/lcm/schemas.json")
Deno.writeTextFileSync(out, JSON.stringify(schemas) + "\n")
console.log(`${Object.keys(schemas).length} structs -> ${out}`)

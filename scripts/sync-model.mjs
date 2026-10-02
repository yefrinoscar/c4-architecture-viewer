import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const modelRoot = process.env.MODEL_DIR ? resolve(process.env.MODEL_DIR) : resolve(projectRoot, '..', 'C4Example-model')

function findDsl() {
  if (process.env.MODEL_FILE) {
    const explicit = resolve(modelRoot, process.env.MODEL_FILE)
    return existsSync(explicit) ? explicit : null
  }
  const defaultPath = join(modelRoot, 'workspace.dsl')
  if (existsSync(defaultPath)) return defaultPath
  if (!existsSync(modelRoot)) return null
  const candidates = readdirSync(modelRoot)
    .filter((entry) => entry.toLowerCase().endsWith('.dsl'))
    .sort()
  if (!candidates.length) return null
  if (candidates.length > 1) {
    console.warn(`[sync-model] Varios .dsl en ${modelRoot}: ${candidates.join(', ')}. Usando ${candidates[0]} (define MODEL_FILE para elegir otro).`)
  }
  return join(modelRoot, candidates[0])
}

const dslPath = findDsl()
const outDir = join(projectRoot, 'public', 'model')
const outPath = join(outDir, 'workspace.dsl')

if (!dslPath) {
  console.warn(`[sync-model] No se encontró ningún .dsl en ${modelRoot}; se conserva el modelo incluido en public/model/.`)
  process.exit(0)
}

const dsl = readFileSync(dslPath, 'utf8')
mkdirSync(outDir, { recursive: true })
copyFileSync(dslPath, outPath)

const unescape = (value) => value.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
const wsMatch = dsl.match(/^workspace\s+"((?:[^"\\]|\\.)*)"(?:\s+"((?:[^"\\]|\\.)*)")?/m)
const manifest = {
  name: wsMatch ? unescape(wsMatch[1]) : 'workspace.dsl',
  description: wsMatch && wsMatch[2] ? unescape(wsMatch[2]) : '',
}
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`[sync-model] ${dslPath} -> public/model/workspace.dsl`)
console.log(`[sync-model] manifest: ${manifest.name}`)

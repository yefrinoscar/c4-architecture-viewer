import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const modelPath = resolve(process.argv[2] ?? join(root, 'public', 'model', 'workspace.dsl'))

const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { parseWorkspace } = await server.ssrLoadModule('/src/dsl/parse.ts')
const { toMermaid } = await server.ssrLoadModule('/src/dsl/mermaid.ts')

const workspace = parseWorkspace(readFileSync(modelPath, 'utf8'))
const synthetic = (type) => ({
  type,
  key: `__${type}`,
  title: '',
  description: '',
  includes: ['*'],
  excludes: [],
  steps: [],
})

function inspect(code) {
  const nodeIds = new Set()
  const subgraphs = new Set()
  const edges = []
  for (const line of code.split('\n')) {
    const subgraph = line.match(/^\s*subgraph\s+(\S+)/)
    if (subgraph) {
      subgraphs.add(subgraph[1])
      continue
    }
    const edge = line.match(/^\s*(\d+)\s*(<)?-\.\s*"(.*)"\s*\.->\s*(\d+)\s*$/)
      ?? line.match(/^\s*(\d+)\s*(<)?-->\|"(.*)"\|\s*(\d+)\s*$/)
    if (edge) {
      edges.push({ from: edge[1], to: edge[4], label: edge[3], bidirectional: Boolean(edge[2]) })
      continue
    }
    const node = line.match(/^\s*(\d+)[([{]/)
    if (node) nodeIds.add(node[1])
  }
  return { nodeIds, subgraphs, edges }
}

const declaredComponentScopes = new Set(workspace.views.filter((view) => view.type === 'component' && view.scope).map((view) => view.scope))
const synthesizedL3 = workspace.elements
  .filter((element) => element.type === 'container'
    && element.children.some((child) => child.type === 'component')
    && !declaredComponentScopes.has(element))
  .map((element) => ({
    label: `sintetizada L3 ${element.varName}`,
    view: { type: 'component', key: `__l3-${element.varName}`, title: '', description: '', scope: element, includes: ['*'], excludes: [], steps: [] },
  }))

const views = [
  ...workspace.views.map((view) => ({ label: `${view.type} ${view.key}`, view })),
  ...synthesizedL3,
  { label: 'generalizado global (todo)', view: synthetic('global') },
  { label: 'generalizado L1', view: synthetic('globalL1') },
  { label: 'generalizado L2', view: synthetic('globalL2') },
  { label: 'generalizado L3', view: synthetic('globalL3') },
  { label: 'generalizado systemLandscape', view: synthetic('systemLandscape') },
]

const problems = []
const rows = []
for (const { label, view } of views) {
  const code = toMermaid(workspace, view)
  const { nodeIds, subgraphs, edges } = inspect(code)
  const broken = edges.filter((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))
  const toBoundary = broken.filter((edge) => subgraphs.has(edge.to) || subgraphs.has(edge.from))
  const selfLoops = edges.filter((edge) => edge.from === edge.to)
  const duplicates = edges.length - new Set(edges.map((edge) => `${edge.from}->${edge.to}`)).size
  const orphans = [...nodeIds].filter((id) => !edges.some((edge) => edge.from === id || edge.to === id))
  const bidirectional = edges.filter((edge) => edge.bidirectional).length
  const unknown = broken.filter((edge) => !subgraphs.has(edge.to) && !subgraphs.has(edge.from))

  rows.push({ label, nodos: nodeIds.size, fronteras: subgraphs.size, aristas: edges.length, rotas: unknown.length, aCaja: toBoundary.length, auto: selfLoops.length, duplicadas: duplicates, bi: bidirectional, aislados: orphans.length })
  if (orphans.length) problems.push(`${label}: ${orphans.length} nodos sin ninguna conexión`)
  if (unknown.length) problems.push(`${label}: ${unknown.length} aristas apuntan a un elemento inexistente`)
  if (selfLoops.length) problems.push(`${label}: ${selfLoops.length} auto-relaciones`)
  if (duplicates) problems.push(`${label}: ${duplicates} aristas duplicadas (mismo par)`)
}

const pad = (value, width) => String(value).padEnd(width)
console.log(`${pad('vista', 38)} ${pad('nodos', 6)} ${pad('cajas', 6)} ${pad('aristas', 8)} ${pad('rotas', 6)} ${pad('aCaja', 6)} ${pad('auto', 5)} ${pad('dup', 4)} ${pad('bidir', 6)} aislados`)
for (const row of rows) {
  console.log(`${pad(row.label, 38)} ${pad(row.nodos, 6)} ${pad(row.fronteras, 6)} ${pad(row.aristas, 8)} ${pad(row.rotas, 6)} ${pad(row.aCaja, 6)} ${pad(row.auto, 5)} ${pad(row.duplicadas, 4)} ${pad(row.bi, 6)} ${row.aislados}`)
}

await server.close()

if (problems.length) {
  console.error('\n[audit-views] problemas encontrados:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`\n[audit-views] OK: ${views.length} vistas (incluye ${synthesizedL3.length} L3 sintetizadas) sin aristas rotas, sin auto-relaciones, sin duplicados ni nodos aislados.`)

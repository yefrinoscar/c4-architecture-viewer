import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseWorkspace } from '../src/dsl/parse.ts'
import { toMermaid } from '../src/dsl/mermaid.ts'

const dslPath = process.argv[2]
const outDir = process.argv[3] ?? '/tmp/mine'

const workspace = parseWorkspace(readFileSync(dslPath, 'utf8'))
console.log(`elements=${workspace.elements.length} relationships=${workspace.relationships.length} views=${workspace.views.length} styles=${workspace.styles.length}`)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

for (const view of workspace.views) {
  const mermaid = toMermaid(workspace, view)
  writeFileSync(join(outDir, `structurizr-${view.key}.mmd`), mermaid)
  console.log(`view ${view.key.padEnd(46)} type=${view.type.padEnd(14)} scope=${(view.scope?.name ?? '*').padEnd(18)} steps=${view.steps.length}`)
}

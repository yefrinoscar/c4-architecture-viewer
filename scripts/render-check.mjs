/**
 * Verifica que TODAS las vistas del modelo se rendericen bien en el navegador:
 *  - ningún nodo recortado por el viewport visible (.canvas)
 *  - ningún nodo tapado por la barra flotante de zoom
 *  - ninguna arista suelta (los dos extremos tocan un nodo o una frontera)
 *  - ningún nodo sin etiqueta ni sin tamaño
 *
 * Necesita Google Chrome instalado. Uso: pnpm run verify:render [ruta/al/modelo.dsl]
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const modelPath = resolve(process.argv[2] ?? join(root, 'public', 'model', 'workspace.dsl'))
const port = 9463

if (!existsSync(chromePath)) {
  console.error(`[verify:render] No se encontró Chrome en ${chromePath}. Define CHROME_PATH.`)
  process.exit(1)
}
if (!existsSync(modelPath)) {
  console.error(`[verify:render] No se encontró el modelo: ${modelPath}`)
  process.exit(1)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
await server.listen()
const url = server.resolvedUrls.local[0]
const chrome = spawn(chromePath, ['--headless=new', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${join(root, '.render-check-profile')}`, 'about:blank'], { stdio: 'ignore' })

let socket
try {
  let targets
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      break
    } catch {
      await sleep(100)
    }
  }
  const page = targets?.find((target) => target.type === 'page' && target.webSocketDebuggerUrl) ?? targets?.[0]
  assert(page, 'no se pudo abrir Chrome')

  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail })
  let id = 0
  const pending = new Map()
  const events = []
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (!message.id) { events.push(message); return }
    const entry = pending.get(message.id)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  }
  const send = (method, params = {}) => new Promise((done, fail) => {
    const n = ++id
    const timer = setTimeout(() => { pending.delete(n); fail(new Error(`Timeout ${method}`)) }, 30000)
    pending.set(n, { resolve: done, reject: fail, timer })
    socket.send(JSON.stringify({ id: n, method, params }))
  })
  const run = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  const wait = async (expression, label) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await run(expression)) return
      await sleep(100)
    }
    throw new Error(`Condition failed: ${label ?? expression}`)
  }
  const click = async (selector) => {
    const point = await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('DOM.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url })
  await wait(`!!document.querySelector('#dsl-file-input')`, 'app shell')
  await run('localStorage.clear()')
  await send('Page.reload')
  await sleep(1200)
  await wait(`!!document.querySelector('#dsl-file-input')`, 'file input')
  await send('Page.setInterceptFileChooserDialog', { enabled: true })
  await click('#dsl-file-input')
  await sleep(100)
  const document0 = await send('DOM.getDocument')
  const input = await send('DOM.querySelector', { nodeId: document0.root.nodeId, selector: '#dsl-file-input' })
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [modelPath] })
  await wait(`!!document.querySelector('.diagram-host svg')`, 'diagram')

  // Modo de trazado opcional: CURVE=curve|straight|orthogonal pnpm run verify:render
  const curveMode = process.env.CURVE
  if (curveMode) {
    const wanted = { curve: 'Curvas', straight: 'Rectas', orthogonal: 'Ortogonales' }[curveMode]
    if (!wanted) throw new Error(`CURVE inválido: ${curveMode}`)
    const current = await run(`document.querySelector('[aria-label="Trazado de líneas"]').textContent.trim()`)
    if (current === wanted) {
      console.log(`modo de líneas: ${wanted} (ya activo)`)
    } else {
    await click('[aria-label="Trazado de líneas"]')
    await wait(`!!document.querySelector('.tool-menu')`, 'curve menu')
    const beforeCurve = await run(`document.querySelector('.diagram-host svg')?.outerHTML.length||0`)
    await run(`[...document.querySelectorAll('.tool-menu-option')].find(b=>b.querySelector('strong').textContent===${JSON.stringify(wanted)}).click()`)
    await sleep(300)
    await wait(`(()=>{const s=document.querySelector('.diagram-host svg');if(!s)return false;return s.outerHTML.length!==${beforeCurve}})()`, 'curve re-render')
    await sleep(600)
    console.log(`modo de líneas: ${wanted}`)
    }
  }

  await run(`window.__lineOverlap = () => {
  const svg = document.querySelector('.diagram-host svg'); if (!svg) return null
  const m = svg.getScreenCTM()
  const toScreen = (pt) => ({ x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f })
  const paths = [...svg.querySelectorAll('path.flowchart-link')]
  const CELL = 4
  const cells = new Map()
  paths.forEach((p, index) => {
    const len = p.getTotalLength()
    const steps = Math.max(12, Math.round(len / 6))
    for (let i = 0; i <= steps; i++) {
      const s = toScreen(p.getPointAtLength((len * i) / steps))
      const key = \`\${Math.round(s.x / CELL)},\${Math.round(s.y / CELL)}\`
      const list = cells.get(key) ?? []
      if (!list.includes(index)) list.push(index)
      cells.set(key, list)
    }
  })
  const shared = new Map()
  for (const list of cells.values()) {
    if (list.length < 2) continue
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const key = \`\${list[i]}-\${list[j]}\`
      shared.set(key, (shared.get(key) ?? 0) + 1)
    }
  }
  const pairs = [...shared.entries()].filter(([, count]) => count >= 8)
  return {
    paths: paths.length,
    crossingPairs: [...shared.values()].filter((c) => c > 0 && c < 5).length,
    overlapPairs: pairs.length,
    worstCells: pairs.length ? Math.max(...pairs.map(([, c]) => c)) : 0,
    pairs: pairs.map(([k, c]) => k + ':' + c).slice(0, 6),
    detail: pairs.map(([, c]) => c).sort((a, b) => b - a)
  }
}

`)

  await run(`window.__measure = () => {
    const svg = document.querySelector('.diagram-host svg')
    if (!svg) return null
    const canvas = document.querySelector('.canvas')
    const frame = canvas.getBoundingClientRect()
    const chromeRects = [...document.querySelectorAll('.stage-toolbar, .stage-toolbar .toolbar-group, .topbar')].map(el => el.getBoundingClientRect())
    const nodes = [...svg.querySelectorAll('g.node')].map(node => {
      const rect = node.getBoundingClientRect()
      return { text: (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40), x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, w: rect.width, h: rect.height }
    })
    const boundaryRects = [...svg.querySelectorAll('g.cluster')].map(cluster => {
      const box = cluster.getBoundingClientRect()
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom }
    })
    const matrix = svg.getScreenCTM()
    const toScreen = (point) => ({ x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f })
    const edges = [...svg.querySelectorAll('path.flowchart-link')].map(path => {
      const length = path.getTotalLength()
      return { id: path.id, start: toScreen(path.getPointAtLength(0)), end: toScreen(path.getPointAtLength(length)) }
    })
    const labels = [...svg.querySelectorAll('g.edgeLabel')].map(label => {
      const rect = label.getBoundingClientRect()
      return { text: (label.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24), x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom }
    })
    const tolerance = 1.5
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height } }
    const displacements = [...svg.querySelectorAll('g.edgeLabel')].map((el) => {
      const transform = el.getAttribute('transform') || ''
      const numbers = (transform.match(/-?[0-9.]+/g) || []).map(Number)
      if (numbers.length < 4) return 0
      const dx = numbers[numbers.length - 2]
      const dy = numbers[numbers.length - 1]
      const rect = el.getBoundingClientRect()
      return Math.round(Math.hypot(dx, dy) * (svg.getScreenCTM()?.a || 1) / Math.max(1, rect.height) * 10) / 10
    })
    const movedLabels = displacements.filter((value) => value > 0)
    const maxLabelShift = movedLabels.length ? Math.max(...movedLabels) : 0
    const lines = window.__lineOverlap()
    const GAP_RATIO = 0.2
    const rawOverlapArea = (a, b) => {
      const w = Math.min(a.right, b.right) - Math.max(a.x, b.x)
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y)
      return w > 0 && h > 0 ? w * h : 0
    }
    const overlapArea = (a, b) => {
      const gap = Math.max(1.5, Math.min(a.h || 0, b.h || 0) * GAP_RATIO)
      const w = Math.min(a.right, b.right) + gap - Math.max(a.x, b.x)
      const h = Math.min(a.bottom, b.bottom) + gap - Math.max(a.y, b.y)
      return w > 0 && h > 0 ? w * h : 0
    }
    const edgeLabelRects = [...svg.querySelectorAll('g.edgeLabel')].map((el) => ({ text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30), ...rect(el) }))
    const nodeRects = [...svg.querySelectorAll('g.node')].map((el) => ({ text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24), ...rect(el) }))
    const clusters = [...svg.querySelectorAll('g.cluster')].map((el) => ({ id: (el.id || '').replace(svg.id + '-', ''), ...rect(el) }))
    const elementBoxList = clusters.filter((cluster) => /^[0-9]+$/.test(cluster.id))
    const elementBoxes = elementBoxList.length
    const centre = (r) => ({ x: (r.x + r.right) / 2, y: (r.y + r.bottom) / 2 })
    const inside = (outer, inner) => {
      const w = Math.min(outer.right, inner.right) - Math.max(outer.x, inner.x)
      const h = Math.min(outer.bottom, inner.bottom) - Math.max(outer.y, inner.y)
      return w > 0 && h > 0 ? (w * h) / (inner.w * inner.h) : 0
    }
    const emptyBoxes = []
    for (const box of elementBoxList) {
      const nodesIn = nodeRects.filter((node) => {
        const point = centre(node)
        return point.x > box.x && point.x < box.right && point.y > box.y && point.y < box.bottom
      }).length
      const boxesIn = elementBoxList.filter((other) => other !== box && inside(box, other) > 0.8).length
      if (nodesIn + boxesIn === 0) emptyBoxes.push(box.id)
    }
    const partialBoxOverlaps = []
    for (let i = 0; i < elementBoxList.length; i += 1) {
      for (let j = i + 1; j < elementBoxList.length; j += 1) {
        const a = elementBoxList[i]
        const b = elementBoxList[j]
        const share = rawOverlapArea(a, b)
        if (!share) continue
        const nested = inside(a, b) > 0.9 || inside(b, a) > 0.9
        if (!nested) partialBoxOverlaps.push(a.id + ' / ' + b.id)
      }
    }
    const labelLabel = []
    for (let i = 0; i < edgeLabelRects.length; i += 1) {
      for (let j = i + 1; j < edgeLabelRects.length; j += 1) {
        if (overlapArea(edgeLabelRects[i], edgeLabelRects[j]) > 0) labelLabel.push(edgeLabelRects[i].text + ' / ' + edgeLabelRects[j].text)
      }
    }
    const labelNode = []
    for (const label of edgeLabelRects) {
      for (const node of nodeRects) {
        if (overlapArea(label, node) > 0) { labelNode.push(label.text + ' sobre ' + node.text); break }
      }
    }
    const nodeNode = []
    for (let i = 0; i < nodeRects.length; i += 1) {
      for (let j = i + 1; j < nodeRects.length; j += 1) {
        if (overlapArea(nodeRects[i], nodeRects[j]) > 0) nodeNode.push(nodeRects[i].text + ' / ' + nodeRects[j].text)
      }
    }
    const groupBoxes = clusters.filter((cluster) => cluster.id.startsWith('rg') || /^g[0-9]+-[0-9]+$/.test(cluster.id)).length
    const overlapsChrome = (rect) => chromeRects.some(c => rect.x < c.right && rect.right > c.x && rect.y < c.bottom && rect.bottom > c.y)
    const touchingNode = (point) => nodes.some(node => point.x >= node.x - 6 && point.x <= node.right + 6 && point.y >= node.y - 6 && point.y <= node.bottom + 6)
      || boundaryRects.some(box => point.x >= box.x - 6 && point.x <= box.right + 6 && point.y >= box.y - 6 && point.y <= box.bottom + 6)
    return {
      nodes: nodes.length,
      edges: edges.length,
      clippedNodes: nodes.filter(node => node.x < frame.x - tolerance || node.y < frame.y - tolerance || node.right > frame.right + tolerance || node.bottom > frame.bottom + tolerance).map(node => node.text),
      hiddenNodes: nodes.filter(node => overlapsChrome(node)).map(node => node.text),
      clippedLabels: labels.filter(label => label.x < frame.x - tolerance || label.right > frame.right + tolerance || label.y < frame.y - tolerance || label.bottom > frame.bottom + tolerance).map(label => label.text),
      dangling: edges.filter(edge => !touchingNode(edge.start) || !touchingNode(edge.end)).map(edge => edge.id),
      emptyLabels: nodes.filter(node => !node.text).length,
      zeroSize: nodes.filter(node => node.w < 4 || node.h < 4).length,
      elementBoxes,
      groupBoxes,
      drawn: nodes.length + elementBoxes,
      labelLabel,
      labelNode,
      nodeNode,
      emptyBoxes,
      partialBoxOverlaps,
      movedLabels: movedLabels.length,
      maxLabelShift,
      lineOverlapDetail: lines ? lines.detail : [],
      lineOverlapPairs: lines ? lines.overlapPairs : 0,
      lineOverlapWorst: lines ? lines.worstCells : 0
    }
  }`)

  const total = await run(`document.querySelectorAll('.sidebar button.nav-item').length`)
  assert(total > 0, 'no hay vistas en el índice')
  const failures = []
  for (let index = 0; index < total; index++) {
    const before = await run(`document.querySelector('.diagram-host svg')?.outerHTML.length||0`)
    const label = await run(`document.querySelectorAll('.sidebar button.nav-item')[${index}].textContent.replace(/(Actual|·)/g,' ').replace(/[\\r\\n]+/g,' ').trim().slice(0,52)`)
    await run(`document.querySelectorAll('.sidebar button.nav-item')[${index}].click()`)
    await sleep(150)
    await wait(`(()=>{const s=document.querySelector('.diagram-host svg');if(!s)return false;return document.querySelector('.canvas-error')||s.outerHTML.length!==${before}})()`, `render ${label}`)
    await sleep(600)
    // al cambiar de vista el transform debe estar aplicado (lo escribe el paneo en el DOM)
    const applied = await run(`(()=>{const t=document.querySelector('.diagram-host')?.style.transform||'';return t.includes('translate') && t.includes('scale')})()`)
    await run(`(()=>{const b=[...document.querySelectorAll('.stage-toolbar button')].find(x=>/Ajustar/.test(x.textContent||''));b.click()})()`)
    await sleep(600)
    const measured = await run('window.__measure()')
    const problems = []
    if (!applied) problems.push('el diagrama no tiene transform aplicado tras cambiar de vista')
    if (measured.clippedNodes.length) problems.push(`${measured.clippedNodes.length} nodos recortados: ${measured.clippedNodes.slice(0, 3).join(' / ')}`)
    if (measured.hiddenNodes.length) problems.push(`${measured.hiddenNodes.length} nodos tapados por la barra: ${measured.hiddenNodes.slice(0, 2).join(' / ')}`)
    if (measured.clippedLabels.length) problems.push(`${measured.clippedLabels.length} etiquetas recortadas: ${measured.clippedLabels.slice(0, 3).join(' / ')}`)
    if (measured.dangling.length) problems.push(`${measured.dangling.length} aristas sueltas: ${measured.dangling.slice(0, 3).join(', ')}`)
    if (measured.emptyLabels) problems.push(`${measured.emptyLabels} nodos sin etiqueta`)
    if (measured.zeroSize) problems.push(`${measured.zeroSize} nodos sin tamaño`)
    if (measured.labelLabel.length) problems.push(`${measured.labelLabel.length} etiquetas superpuestas: ${measured.labelLabel.slice(0, 2).join(' | ')}`)
    if (measured.labelNode.length) problems.push(`${measured.labelNode.length} etiquetas sobre nodos: ${measured.labelNode.slice(0, 2).join(' | ')}`)
    if (measured.nodeNode.length) problems.push(`${measured.nodeNode.length} nodos superpuestos: ${measured.nodeNode.slice(0, 2).join(' | ')}`)
    if (measured.drawn === 0) problems.push('la vista no dibuja ningún elemento')
    if (measured.emptyBoxes.length) problems.push(`${measured.emptyBoxes.length} cajas vacías: ${measured.emptyBoxes.slice(0, 3).join(', ')}`)
    if (measured.partialBoxOverlaps.length) problems.push(`${measured.partialBoxOverlaps.length} cajas solapadas sin anidar: ${measured.partialBoxOverlaps.slice(0, 2).join(' | ')}`)
    if (measured.lineOverlapDetail?.length) console.log('     aristas pegadas:', JSON.stringify(measured.lineOverlapDetail))
    if (measured.lineOverlapPairs > 0) problems.push(`${measured.lineOverlapPairs} pares de aristas pegadas (hasta ${measured.lineOverlapWorst} celdas)`)
    if (measured.maxLabelShift > 6) problems.push(`etiquetas desplazadas demasiado lejos de su línea (hasta ${measured.maxLabelShift}x su alto)`)
    console.log(`${problems.length ? 'FALLA' : 'ok   '} ${label.padEnd(52)} nodos=${String(measured.nodes).padStart(2)} cajas=${String(measured.elementBoxes).padStart(2)} aristas=${String(measured.edges).padStart(2)} movidas=${String(measured.movedLabels).padStart(2)}${problems.length ? ' :: ' + problems.join(' | ') : ''}`)
    if (problems.length) failures.push({ label, problems })
  }

  const runtimeErrors = events.filter((event) => event.method === 'Runtime.exceptionThrown')
  assert.equal(runtimeErrors.length, 0, JSON.stringify(runtimeErrors.map((event) => event.params.exceptionDetails.text)))

  if (failures.length) {
    console.error(`\n[verify:render] ${failures.length} vistas con problemas:`)
    for (const failure of failures) console.error(`  - ${failure.label}: ${failure.problems.join(' | ')}`)
    process.exitCode = 1
  } else {
    console.log(`\n[verify:render] OK: ${total} vistas${curveMode ? ` (líneas: ${curveMode})` : ''} — sin recortes, sin nodos tapados, sin aristas sueltas, sin solapes, todos los elementos dibujados.`)
  }
} finally {
  socket?.close()
  chrome.kill()
  await server.close()
}

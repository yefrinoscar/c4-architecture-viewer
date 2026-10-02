import { memo, useEffect, useState } from 'react'
import type { RefObject } from 'react'
import type mermaidType from 'mermaid'
import { diagramOverrides, mermaidCurve, type CurveMode, type DiagramPalette } from '../dsl/mermaid.ts'

let mermaidPromise: Promise<typeof mermaidType> | null = null
let renderSeq = 0

function loadMermaid(): Promise<typeof mermaidType> {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((module) => module.default)
  return mermaidPromise
}

interface GluedPair {
  first: SVGPathElement
  second: SVGPathElement
  count: number
  cells: [number, number][]
}

/** Pares de aristas que comparten corredor (van pegadas más de ~5 celdas seguidas). */
function gluedPairs(svg: SVGSVGElement, paths: SVGPathElement[]): GluedPair[] {
  const matrix = svg.getScreenCTM()
  const CELL = 4
  const cells = new Map<string, number[]>()
  paths.forEach((path, index) => {
    const length = path.getTotalLength()
    if (!length) return
    const steps = Math.max(12, Math.round(length / 6))
    for (let step = 0; step <= steps; step += 1) {
      const point = path.getPointAtLength((length * step) / steps)
      const x = matrix ? point.x * matrix.a + point.y * matrix.c + matrix.e : point.x
      const y = matrix ? point.x * matrix.b + point.y * matrix.d + matrix.f : point.y
      const key = `${Math.round(x / CELL)},${Math.round(y / CELL)}`
      const list = cells.get(key) ?? []
      if (!list.includes(index)) list.push(index)
      cells.set(key, list)
    }
  })
  const shared = new Map<string, [number, number][]>()
  for (const [cell, list] of cells) {
    if (list.length < 2) continue
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const key = `${list[i]}|${list[j]}`
        const [cx, cy] = cell.split(',').map(Number)
        shared.set(key, [...(shared.get(key) ?? []), [cx, cy]])
      }
    }
  }
  return [...shared.entries()]
    .filter(([, list]) => list.length >= 8)
    .map(([key, list]) => {
      const [first, second] = key.split('|').map(Number)
      return { first: paths[first] as SVGPathElement, second: paths[second] as SVGPathElement, count: list.length, cells: list }
    })
}

const CELL_SIZE = 4

/** Separa dos aristas que comparten recorrido, abultando la segunda justo en ese tramo. */
function pushApart(pair: GluedPair, matrix: DOMMatrix | null, amount: number) {
  const shared = pair.cells.map(([cx, cy]) => {
    const x = cx * CELL_SIZE
    const y = cy * CELL_SIZE
    return matrix
      ? { x: (x - matrix.e) / matrix.a, y: (y - matrix.f) / matrix.d }
      : { x, y }
  })
  const centre = shared.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), { x: 0, y: 0 })
  centre.x /= shared.length
  centre.y /= shared.length

  const path = pair.second
  const length = path.getTotalLength()
  if (!length) return
  const steps = Math.max(12, Math.round(length / 8))
  const radius = 90
  const points = Array.from({ length: steps + 1 }, (_, index) => path.getPointAtLength((length * index) / steps))
  // dirección local cerca del tramo compartido
  let dx = 0
  let dy = 0
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    if (Math.hypot(to.x - centre.x, to.y - centre.y) > radius) continue
    dx += to.x - from.x
    dy += to.y - from.y
  }
  const norm = Math.hypot(dx, dy) || 1
  const px = -dy / norm
  const py = dx / norm
  // lado hacia el que mover: el opuesto al de la otra arista
  const other = pair.first.getPointAtLength(pair.first.getTotalLength() / 2)
  const sign = (other.x - centre.x) * px + (other.y - centre.y) * py > 0 ? -1 : 1
  const parts = points.map((point, index) => {
    const weight = Math.max(0, 1 - Math.hypot(point.x - centre.x, point.y - centre.y) / radius)
    const x = point.x + px * sign * amount * weight
    const y = point.y + py * sign * amount * weight
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  })
  path.setAttribute('d', parts.join(''))
}

/** Ninguna arista debe compartir recorrido con otra. */
function separateGluedEdges(svg: SVGSVGElement) {
  const paths = [...svg.querySelectorAll<SVGPathElement>('path.flowchart-link')]
  if (paths.length < 2) return
  const matrix = svg.getScreenCTM()
  const scale = matrix?.a || 1
  for (let round = 0; round < 6; round += 1) {
    const glued = gluedPairs(svg, paths)
    if (!glued.length) break
    for (const pair of glued) pushApart(pair, matrix, (10 + round * 3) / scale)
  }
}

/** En modo Rectas se ignoran los puntos intermedios de Dagre: un solo segmento. */
function straightenEdges(svg: SVGSVGElement) {
  for (const path of svg.querySelectorAll<SVGPathElement>('path.flowchart-link')) {
    const length = path.getTotalLength()
    if (!length) continue
    const start = path.getPointAtLength(0)
    const end = path.getPointAtLength(length)
    path.setAttribute('d', `M${start.x.toFixed(1)},${start.y.toFixed(1)} L${end.x.toFixed(1)},${end.y.toFixed(1)}`)
  }
}

interface DirectedEdge {
  source: number
  destination: number
}

/**
 * Las llamadas SYS hacia contratos API superiores suben por el espacio libre
 * a la izquierda de la columna y apuntan al lateral del componente. La lista
 * explícita evita alterar otras relaciones con figuras visualmente similares.
 */
function curveUpwardApiEdges(svg: SVGSVGElement, edges: DirectedEdge[]) {
  const wanted = new Set(edges.map(({ source, destination }) => `${source}->${destination}`))
  if (!wanted.size) return
  const nodes = new Map<string, SVGGElement>()
  for (const node of svg.querySelectorAll<SVGGElement>('g.node')) {
    const id = node.id.match(/flowchart-(\d+)-/)?.[1]
    if (id) nodes.set(id, node)
  }

  for (const path of svg.querySelectorAll<SVGPathElement>('path.flowchart-link')) {
    const ids = path.dataset.id?.match(/^L_(\d+)_(\d+)_/)
    if (!ids || !wanted.has(`${ids[1]}->${ids[2]}`)) continue
    const sourceShape = nodes.get(ids[1])?.querySelector<SVGGraphicsElement>('.label-container')
    const destinationShape = nodes.get(ids[2])?.querySelector<SVGGraphicsElement>('.label-container')
    if (!sourceShape || !destinationShape) continue
    const destinationBox = destinationShape.getBoundingClientRect()
    const matrix = path.getScreenCTM()
    const length = path.getTotalLength()
    if (!matrix || !length) continue
    const originalStart = path.getPointAtLength(0)
    const startScreen = new DOMPoint(
      originalStart.x * matrix.a + originalStart.y * matrix.c + matrix.e,
      originalStart.x * matrix.b + originalStart.y * matrix.d + matrix.f,
    )
    const endScreen = new DOMPoint(destinationBox.left, (destinationBox.top + destinationBox.bottom) / 2)
    const horizontal = endScreen.x - startScreen.x
    const vertical = startScreen.y - endScreen.y
    if (horizontal < 80 || vertical < 40) continue

    // Los controles quedan fuera de la columna de APIs: la curva asciende sin
    // atravesar los componentes inferiores y entra horizontalmente al destino.
    const gutterX = endScreen.x - Math.min(120, Math.max(56, horizontal * 0.24))
    const firstControl = new DOMPoint(gutterX, startScreen.y)
    const secondControl = new DOMPoint(gutterX, endScreen.y)
    const inverse = matrix.inverse()
    const [start, first, second, end] = [startScreen, firstControl, secondControl, endScreen]
      .map((point) => point.matrixTransform(inverse))
    path.setAttribute('d', `M${start.x.toFixed(1)},${start.y.toFixed(1)} C${first.x.toFixed(1)},${first.y.toFixed(1)} ${second.x.toFixed(1)},${second.y.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`)
    path.dataset.upwardApiCurve = 'true'
  }
}

/**
 * Mermaid dibuja las etiquetas de arista como HTML dentro de `foreignObject`.
 * Chrome puede conservar el fondo pero omitir el texto al escalar diagramas
 * grandes. Se reemplazan por SVG nativo para que las acciones siempre se pinten.
 */
function materializeEdgeLabels(svg: SVGSVGElement, palette: DiagramPalette) {
  const namespace = 'http://www.w3.org/2000/svg'
  for (const edgeLabel of svg.querySelectorAll<SVGGElement>('g.edgeLabel')) {
    const foreignObject = edgeLabel.querySelector('foreignObject')
    const label = edgeLabel.querySelector<SVGGElement>('g.label')
    if (!foreignObject || !label) continue
    const leafBlocks = [...foreignObject.querySelectorAll<HTMLElement>('div, p')]
      .filter((element) => !element.querySelector('div, p'))
      .map((element) => (element.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    const fallback = (foreignObject.textContent || '').replace(/\s+/g, ' ').trim()
    const lines = [...new Set(leafBlocks.length ? leafBlocks : fallback ? [fallback] : [])]
    if (!lines.length) continue

    const fontSize = 14
    const lineHeight = 18
    const width = Math.max(54, Math.max(...lines.map((line) => [...line].length)) * 7.6 + 22)
    const height = lines.length * lineHeight + 10
    label.replaceChildren()
    label.setAttribute('transform', `translate(${-width / 2}, ${-height / 2})`)
    label.setAttribute('data-native-edge-label', 'true')

    const background = document.createElementNS(namespace, 'rect')
    background.setAttribute('width', String(width))
    background.setAttribute('height', String(height))
    background.setAttribute('rx', '4')
    background.setAttribute('fill', palette.labelFill)
    background.setAttribute('stroke', palette.boundaryStroke)
    background.setAttribute('stroke-width', '0.8')
    // Mermaid aplica a cualquier `rect` de edgeLabel su color y opacity propios.
    // Las propiedades inline con prioridad evitan que la arista se transparente.
    background.style.setProperty('fill', palette.labelFill, 'important')
    background.style.setProperty('fill-opacity', '1', 'important')
    background.style.setProperty('opacity', '1', 'important')
    background.style.setProperty('stroke', palette.boundaryStroke, 'important')
    label.appendChild(background)

    const text = document.createElementNS(namespace, 'text')
    text.setAttribute('x', String(width / 2))
    text.setAttribute('y', String(height / 2 - ((lines.length - 1) * lineHeight) / 2 + 5))
    text.setAttribute('fill', palette.labelColor)
    text.setAttribute('font-size', String(fontSize))
    text.setAttribute('font-family', "'IBM Plex Sans', system-ui, sans-serif")
    text.setAttribute('font-weight', '600')
    text.setAttribute('text-anchor', 'middle')
    lines.forEach((line, index) => {
      const span = document.createElementNS(namespace, 'tspan')
      span.setAttribute('x', String(width / 2))
      if (index) span.setAttribute('dy', String(lineHeight))
      span.textContent = line
      text.appendChild(span)
    })
    label.appendChild(text)
  }
}

/** SVG pinta según el orden del DOM; las etiquetas deben quedar después de las aristas. */
function bringEdgeLabelsToFront(svg: SVGSVGElement) {
  const groups = [...svg.querySelectorAll<SVGGElement>('g.edgeLabels')]
  for (const group of groups) group.parentNode?.appendChild(group)
}

/** Mantiene cada acción sobre su propia arista y busca allí un tramo sin nodos. */
function alignEdgeLabelsToPaths(svg: SVGSVGElement) {
  const paths = [...svg.querySelectorAll<SVGPathElement>('path.flowchart-link')]
  const obstacles = [...svg.querySelectorAll<SVGGElement>('g.node')].map((node) => node.getBoundingClientRect())
  const placed: DOMRect[] = []
  const ratios = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]
  const overlapArea = (rect: DOMRect, other: DOMRect, margin = 4) => {
    const width = Math.min(rect.right, other.right + margin) - Math.max(rect.left, other.left - margin)
    const height = Math.min(rect.bottom, other.bottom + margin) - Math.max(rect.top, other.top - margin)
    return width > 0 && height > 0 ? width * height : 0
  }

  for (const edgeLabel of svg.querySelectorAll<SVGGElement>('g.edgeLabel')) {
    const id = edgeLabel.querySelector<SVGGElement>('g.label')?.dataset.id
    const path = id ? paths.find((candidate) => candidate.dataset.id === id) : undefined
    if (!path) continue
    const length = path.getTotalLength()
    if (!length) continue

    let best: { point: DOMPoint; score: number } | undefined
    for (const ratio of ratios) {
      const point = path.getPointAtLength(length * ratio)
      edgeLabel.setAttribute('transform', `translate(${point.x}, ${point.y})`)
      const rect = edgeLabel.getBoundingClientRect()
      const collision = [...obstacles, ...placed].reduce((sum, other) => sum + overlapArea(rect, other), 0)
      const score = collision + Math.abs(ratio - 0.5) * 10
      if (!best || score < best.score) best = { point, score }
      if (collision === 0) break
    }
    if (!best) continue
    edgeLabel.setAttribute('transform', `translate(${best.point.x}, ${best.point.y})`)
    placed.push(edgeLabel.getBoundingClientRect())
  }
}

/** Agrega el tag visual sin modificar el tamaño que Mermaid calculó para el nodo. */
function materializeNewBadges(svg: SVGSVGElement, elementIds: number[]) {
  const namespace = 'http://www.w3.org/2000/svg'
  for (const elementId of elementIds) {
    const node = svg.querySelector<SVGGElement>(`g.node[id*="-flowchart-${elementId}-"]`)
    const shape = node?.querySelector<SVGGraphicsElement>('.label-container')
    if (!node || !shape || node.querySelector('[data-new-badge="true"]')) continue
    const matrix = node.getScreenCTM()
    if (!matrix) continue
    const inverse = matrix.inverse()
    const screenBox = shape.getBoundingClientRect()
    const corners = [
      new DOMPoint(screenBox.left, screenBox.top),
      new DOMPoint(screenBox.right, screenBox.top),
      new DOMPoint(screenBox.right, screenBox.bottom),
      new DOMPoint(screenBox.left, screenBox.bottom),
    ].map((point) => point.matrixTransform(inverse))
    const right = Math.max(...corners.map((point) => point.x))
    const top = Math.min(...corners.map((point) => point.y))
    const x = right - 60
    const y = top + 8

    const badge = document.createElementNS(namespace, 'g')
    badge.setAttribute('data-new-badge', 'true')
    badge.setAttribute('aria-label', 'New')

    const background = document.createElementNS(namespace, 'rect')
    background.setAttribute('x', String(x))
    background.setAttribute('y', String(y))
    background.setAttribute('width', '50')
    background.setAttribute('height', '22')
    background.setAttribute('rx', '11')
    background.style.setProperty('fill', '#facc15', 'important')
    background.style.setProperty('opacity', '1', 'important')
    background.style.setProperty('stroke', '#a16207', 'important')
    background.style.setProperty('stroke-width', '1px', 'important')
    badge.appendChild(background)

    const text = document.createElementNS(namespace, 'text')
    text.setAttribute('x', String(x + 25))
    text.setAttribute('y', String(y + 15))
    text.setAttribute('text-anchor', 'middle')
    text.setAttribute('font-size', '11.5')
    text.setAttribute('font-family', "'IBM Plex Sans', system-ui, sans-serif")
    text.setAttribute('font-weight', '700')
    text.style.setProperty('fill', '#422006', 'important')
    text.textContent = 'New'
    badge.appendChild(text)
    node.appendChild(badge)
  }
}

/** mermaid guarda la configuración de forma global: se re-aplica antes de cada render. */
function configureMermaid(mermaid: typeof mermaidType, curve: CurveMode, spacing: 'compact' | 'normal' | 'spacious' | 'huge' | 'global') {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'base',
    fontFamily: "'Inter Variable', 'Inter', system-ui, sans-serif",
    flowchart: {
      htmlLabels: true,
      useMaxWidth: false,
      padding: spacing === 'huge' ? 44 : spacing === 'spacious' ? 38 : spacing === 'global' ? 34 : spacing === 'compact' ? 18 : 30,
      nodeSpacing: spacing === 'huge' ? 300 : spacing === 'spacious' ? 190 : spacing === 'global' ? 140 : spacing === 'compact' ? 48 : 104,
      rankSpacing: spacing === 'huge' ? 460 : spacing === 'spacious' ? 300 : spacing === 'global' ? 230 : spacing === 'compact' ? 76 : 170,
      curve: mermaidCurve(curve),
    },
  })
}

interface MermaidProps {
  code: string
  palette: DiagramPalette
  curve: CurveMode
  spacing?: 'compact' | 'normal' | 'spacious' | 'huge' | 'global'
  nativeEdgeLabels?: boolean
  upwardApiEdges?: DirectedEdge[]
  newElementIds?: number[]
  hostRef: RefObject<HTMLDivElement | null>
  onSize: (size: { width: number; height: number } | null) => void
}

export const Mermaid = memo(function Mermaid({ code, palette, curve, spacing = 'normal', nativeEdgeLabels = false, upwardApiEdges = [], newElementIds = [], hostRef, onSize }: MermaidProps) {
  // El transform lo escribe usePanZoom directamente en el DOM (sin re-render de
  // React por frame); por eso aquí no se pone en el style.
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null)
  const error = failure?.code === code ? failure.message : null

  useEffect(() => {
    const host = hostRef.current
    let cancelled = false

    loadMermaid()
      .then((mermaid) => {
        configureMermaid(mermaid, curve, spacing)
        return mermaid.render(`c4-${++renderSeq}`, code)
      })
      .then(({ svg }) => {
        if (cancelled || !host) return
        const id = svg.match(/<svg[^>]*\sid="([^"]+)"/)?.[1]
        host.innerHTML = id ? svg.replace(/(<svg[^>]*>)/, `$1${diagramOverrides(id, palette)}`) : svg
        const svgElement = host.querySelector('svg')
        if (!svgElement) return
        const element = svgElement
        const viewBox = element.viewBox.baseVal
        const width = viewBox.width || element.clientWidth
        const height = viewBox.height || element.clientHeight
        element.setAttribute('width', String(width))
        element.setAttribute('height', String(height))
        element.style.width = `${width}px`
        element.style.height = `${height}px`
        element.style.maxWidth = 'none'
        // Las etiquetas HTML de Mermaid (`foreignObject`) dejan ver el tramo
        // de la arista al escalar vistas L1/L2/L3. Las convertimos siempre a
        // SVG nativo, igual que ya se hacía en Arquitectura por capas.
        materializeEdgeLabels(svgElement, palette)
        if (curve === 'straight') straightenEdges(svgElement)
        else separateGluedEdges(svgElement)
        if (nativeEdgeLabels && curve === 'curve') curveUpwardApiEdges(svgElement, upwardApiEdges)
        alignEdgeLabelsToPaths(svgElement)
        bringEdgeLabelsToFront(svgElement)
        materializeNewBadges(svgElement, newElementIds)
        onSize({ width, height })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setFailure({ code, message: err instanceof Error ? err.message : String(err) })
      })

    return () => {
      cancelled = true
      if (host) host.innerHTML = ''
    }
  }, [code, curve, spacing, nativeEdgeLabels, upwardApiEdges, newElementIds, palette, hostRef, onSize])

  return (
    <>
      {error && <div className="canvas-error" role="alert"><strong>No se pudo renderizar el diagrama</strong><pre>{error}</pre></div>}
      <div ref={hostRef} className="diagram-host" />
    </>
  )
})

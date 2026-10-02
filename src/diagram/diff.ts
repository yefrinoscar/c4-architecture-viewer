export interface DiffHunk {
  start: number
  before: string[]
  after: string[]
  beforeTotal: number
  afterTotal: number
}

export interface DiffStats {
  added: number
  removed: number
  changed: number
  start: number
}

export interface ChangeLine {
  line: number
  from: string
  to: string
}

interface DiffOp {
  kind: 'change' | 'add' | 'remove'
  oldLine?: number
  newLine?: number
}

const MAX_CELLS = 4_000_000

function toLines(text: string): string[] {
  return text.replace(/\n$/, '').split('\n')
}

function lcsOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length
  const m = newLines.length
  const width = m + 1
  const table = new Int32Array((n + 1) * width)
  for (let index = n - 1; index >= 0; index -= 1) {
    for (let other = m - 1; other >= 0; other -= 1) {
      table[index * width + other] = oldLines[index] === newLines[other]
        ? table[(index + 1) * width + other + 1] + 1
        : Math.max(table[(index + 1) * width + other], table[index * width + other + 1])
    }
  }
  const ops: DiffOp[] = []
  let index = 0
  let other = 0
  let pendingOld: number[] = []
  let pendingNew: number[] = []
  const flush = () => {
    const pairs = Math.min(pendingOld.length, pendingNew.length)
    for (let pair = 0; pair < pairs; pair += 1) ops.push({ kind: 'change', oldLine: pendingOld[pair], newLine: pendingNew[pair] })
    for (let pair = pairs; pair < pendingOld.length; pair += 1) ops.push({ kind: 'remove', oldLine: pendingOld[pair] })
    for (let pair = pairs; pair < pendingNew.length; pair += 1) ops.push({ kind: 'add', newLine: pendingNew[pair] })
    pendingOld = []
    pendingNew = []
  }
  while (index < n || other < m) {
    if (index < n && other < m && oldLines[index] === newLines[other]) {
      flush()
      index += 1
      other += 1
    } else if (other < m && (index === n || table[index * width + other + 1] >= table[(index + 1) * width + other])) {
      pendingNew.push(other)
      other += 1
    } else {
      pendingOld.push(index)
      index += 1
    }
  }
  flush()
  return ops
}

function positionalOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const ops: DiffOp[] = []
  const paired = Math.min(oldLines.length, newLines.length)
  for (let index = 0; index < paired; index += 1) {
    if (oldLines[index] !== newLines[index]) ops.push({ kind: 'change', oldLine: index, newLine: index })
  }
  for (let index = paired; index < oldLines.length; index += 1) ops.push({ kind: 'remove', oldLine: index })
  for (let index = paired; index < newLines.length; index += 1) ops.push({ kind: 'add', newLine: index })
  return ops
}

function middle(before: string, after: string) {
  const oldLines = toLines(before)
  const newLines = toLines(after)
  let start = 0
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) start += 1
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1
    newEnd -= 1
  }
  return { oldLines, newLines, start, middleOld: oldLines.slice(start, oldEnd), middleNew: newLines.slice(start, newEnd) }
}

function opsFor(before: string, after: string): DiffOp[] {
  const { start, middleOld, middleNew } = middle(before, after)
  const raw = middleOld.length * middleNew.length > MAX_CELLS
    ? positionalOps(middleOld, middleNew)
    : lcsOps(middleOld, middleNew)
  return raw.map((op) => ({
    ...op,
    oldLine: op.oldLine === undefined ? undefined : op.oldLine + start,
    newLine: op.newLine === undefined ? undefined : op.newLine + start,
  }))
}

export function diffStats(before: string, after: string): DiffStats {
  const ops = opsFor(before, after)
  return {
    added: ops.filter((op) => op.kind === 'add').length,
    removed: ops.filter((op) => op.kind === 'remove').length,
    changed: ops.filter((op) => op.kind === 'change').length,
    start: middle(before, after).start,
  }
}

export function changeLines(before: string, after: string, limit = 8): ChangeLine[] {
  const oldLines = toLines(before)
  const newLines = toLines(after)
  const changes: ChangeLine[] = []
  for (const op of opsFor(before, after)) {
    if (changes.length >= limit) break
    if (op.kind === 'change') {
      const from = (oldLines[op.oldLine ?? 0] ?? '').trim()
      const to = (newLines[op.newLine ?? 0] ?? '').trim()
      if (!from && !to) continue
      changes.push({ line: (op.newLine ?? 0) + 1, from, to })
    } else if (op.kind === 'add') {
      const to = (newLines[op.newLine ?? 0] ?? '').trim()
      if (!to) continue
      changes.push({ line: (op.newLine ?? 0) + 1, from: '', to })
    }
  }
  return changes
}

export function removedLines(before: string, after: string, limit = 8): ChangeLine[] {
  const oldLines = toLines(before)
  const removals: ChangeLine[] = []
  for (const op of opsFor(before, after)) {
    if (removals.length >= limit) break
    if (op.kind === 'remove') {
      const from = (oldLines[op.oldLine ?? 0] ?? '').trim()
      if (!from) continue
      removals.push({ line: (op.oldLine ?? 0) + 1, from, to: '' })
    }
  }
  return removals
}

const FENCE_OPEN = /^ {0,3}```dsl[^\S\r\n]*\r?\n/m
const FENCE_CLOSE = /\r?\n {0,3}```[^\S\r\n]*(?:\r?\n|$)/

export function computeDiff(before: string, after: string): DiffHunk {
  const oldLines = toLines(before)
  const newLines = toLines(after)
  let start = 0
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) start += 1
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1
    newEnd -= 1
  }
  return {
    start,
    before: oldLines.slice(start, oldEnd),
    after: newLines.slice(start, newEnd),
    beforeTotal: oldLines.length,
    afterTotal: newLines.length,
  }
}

export function changeSummary(stats: DiffStats): string {
  const parts: string[] = []
  if (stats.added) parts.push(`${stats.added} ${stats.added === 1 ? 'línea añadida' : 'líneas añadidas'}`)
  if (stats.removed) parts.push(`${stats.removed} ${stats.removed === 1 ? 'línea eliminada' : 'líneas eliminadas'}`)
  if (stats.changed) parts.push(`${stats.changed} ${stats.changed === 1 ? 'línea modificada' : 'líneas modificadas'}`)
  return parts.length ? parts.join(', ') : 'Sin cambios de línea respecto al documento'
}

export function streamStats(before: string, partial: string): { written: number; changed: number; added: number } {
  const oldLines = toLines(before)
  const newLines = toLines(partial)
  const common = Math.min(oldLines.length, newLines.length)
  let changed = 0
  for (let index = 0; index < common; index += 1) {
    if (oldLines[index] !== newLines[index]) changed += 1
  }
  return { written: newLines.length, changed, added: Math.max(0, newLines.length - oldLines.length) }
}

export function openDslFence(content: string): string | undefined {
  const open = FENCE_OPEN.exec(content)
  if (!open || open.index === undefined) return undefined
  const rest = content.slice(open.index + open[0].length)
  const close = FENCE_CLOSE.exec(rest)
  return close && close.index !== undefined ? rest.slice(0, close.index) : rest
}

export function suggestedFileName(name: string | undefined, suffix = '-propuesta'): string {
  const raw = (name ?? 'workspace').trim().replace(/\.dsl$/i, '') || 'workspace'
  return `${raw.replace(/[^\w.-]+/g, '-')}${suffix}.dsl`
}

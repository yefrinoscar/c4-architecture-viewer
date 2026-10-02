import { useLayoutEffect, useMemo } from 'react'
import type { RefObject } from 'react'
import { architectureBandName, architectureBandOrder, isTopicElement, missingElementOperations, missingTransactApiEndpoint, viewDiagram } from '../dsl/mermaid.ts'
import type { DiagramRelationship } from '../dsl/mermaid.ts'
import type { Element, View, Workspace } from '../dsl/parse.ts'

interface LayeredArchitectureProps {
  workspace: Workspace
  view: View
  dark: boolean
  hostRef: RefObject<HTMLDivElement | null>
  onSize: (size: { width: number; height: number } | null) => void
}

type NodeKind = 'api' | 'microservice' | 'topic' | 'function' | 'system' | 'other'

interface NodePosition {
  element: Element
  x: number
  y: number
  width: number
  height: number
  region: 'left' | 'main' | 'right'
  kind: NodeKind
  domain: string
  nameLines: string[]
  descriptionLines: string[]
}

interface BandLayout {
  id: string
  title: string
  x: number
  y: number
  width: number
  height: number
  count: number
}

interface SatelliteLabel {
  id: string
  title: string
  x: number
  y: number
  width: number
  count: number
}

interface ItemSpec {
  width: number
  height: number
  element: Element
}

interface PreparedRow {
  center: ItemSpec[]
  left?: ItemSpec
  right?: ItemSpec
  height: number
  gapAfter: number
}

interface EdgeGeometry {
  d: string
  labelX: number
  labelY: number
}

const WIDTH = 1920
const OUTER = 32
const BAND_GAP = 140
const BAND_HEADER = 58
const BAND_INSET = 42
const ITEM_GAP_X = 96
const ITEM_GAP_Y = 54
const EVENT_ROW_GAP = 92
const ROLE_ROW_GAP = 72
const TOPIC_SIDE_GAP = 24
const STANDALONE_WIDTH = 360
const MICROSERVICE_WIDTH = 400
const EVENT_WIDTH = 410
const SIDECAR_WIDTH = 390
const SIDECAR_GAP = 40
const MAX_ROW_WIDTH = WIDTH - OUTER * 2 - BAND_INSET * 2

function textLines(text: string, max = 28): string[] {
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => {
      if (word.length <= max) return [word]
      const parts: string[] = []
      for (let index = 0; index < word.length; index += max) parts.push(word.slice(index, index + max))
      return parts
    })
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current || `${current} ${word}`.length <= max) current = current ? `${current} ${word}` : word
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

function rootElement(element: Element): Element {
  let current = element
  while (current.parent) current = current.parent
  return current
}

function nodeKind(element: Element): NodeKind {
  const tags = new Set(element.tags.map((tag) => tag.toLowerCase()))
  const searchable = `${element.name} ${element.technology}`.toLowerCase()
  if (tags.has('api') || /^api[-.]/i.test(element.name)) return 'api'
  if (tags.has('microservice') || /^mic[-.]/i.test(element.name)) return 'microservice'
  if (isTopicElement(element) || /topic|queue|event hubs|service bus|kafka/.test(searchable)) return 'topic'
  if (tags.has('function') || /^fnc[-.]/i.test(element.name)) return 'function'
  if (element.type === 'softwareSystem' || element.type === 'person') return 'system'
  return 'other'
}

function isNewElement(element: Element): boolean {
  return element.tags.some((tag) => tag.trim().toLowerCase() === 'new')
}

function functionalDomain(element: Element): string {
  const explicit = element.properties['architecture.domain']?.trim()
    || element.properties['bian.sd']?.trim()
  if (explicit) return explicit

  const serviceDomain = element.group?.split('/').map((part) => part.trim())
    .find((part) => /^service domain\s*-/i.test(part))
  if (serviceDomain) return serviceDomain.replace(/^service domain\s*-\s*/i, '').trim()

  const searchable = `${element.name} ${element.description}`
  if (/customer[- ]offer/i.test(searchable)) return 'Customer Offer'
  if (/loan|repayment|prepayment|schedule/i.test(searchable)) return 'Loan'
  if (/transact/i.test(searchable)) return 'Transact'
  if (/parameter|shared|util/i.test(searchable)) return 'Shared'
  return rootElement(element).name
}

function serviceKey(element: Element): string {
  return element.name.toLowerCase()
    .replace(/^(api|mic)[-.]/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function relationshipKey(left: Element, right: Element): string {
  return left.id < right.id ? `${left.id}:${right.id}` : `${right.id}:${left.id}`
}

function ownershipFor(nodes: Element[], relationships: DiagramRelationship[]): Map<number, number> {
  const ownership = new Map<number, number>()
  const connected = new Set(relationships.map((relationship) => relationshipKey(relationship.source, relationship.destination)))
  const apis = nodes.filter((element) => nodeKind(element) === 'api')

  for (const micro of nodes.filter((element) => nodeKind(element) === 'microservice')) {
    const candidates = apis.filter((api) => architectureBandName(api) === architectureBandName(micro))
    let best: { api: Element; score: number } | undefined
    for (const api of candidates) {
      const exact = serviceKey(api) === serviceKey(micro)
      const related = connected.has(relationshipKey(api, micro))
      if (!exact && !related) continue
      const apiTokens = new Set(serviceKey(api).split('-'))
      const shared = serviceKey(micro).split('-').filter((token) => apiTokens.has(token)).length
      const score = (exact ? 1000 : 0) + (related ? 500 : 0) + shared
      if (score > (best?.score ?? 0)) best = { api, score }
    }
    if (best) ownership.set(micro.id, best.api.id)
  }
  return ownership
}

function nodeContent(element: Element, width: number) {
  const nameLines = textLines(element.name, Math.max(20, Math.floor(width / 8.2)))
  const endpoint = missingTransactApiEndpoint(element)
  const operations = missingElementOperations(element)
  const content = [
    element.description,
    operations.length ? `Operation: ${operations.join(' · ')}` : '',
    endpoint ? `Endpoint: ${endpoint}` : '',
  ].filter(Boolean).join(' ')
  const descriptionLines = textLines(content, Math.max(26, Math.floor(width / 6.7)))
  const height = Math.max(
    84,
    18 + (isNewElement(element) ? 28 : 0) + nameLines.length * 17 + (descriptionLines.length ? 10 + descriptionLines.length * 15 : 0) + 18,
  )
  return { nameLines, descriptionLines, height }
}

function itemSpec(element: Element): ItemSpec {
  const kind = nodeKind(element)
  const width = kind === 'topic' ? EVENT_WIDTH : kind === 'microservice' ? MICROSERVICE_WIDTH : STANDALONE_WIDTH
  return { width, height: nodeContent(element, width).height, element }
}

function flowOrder(members: Element[], ownership: Map<number, number>): Element[] {
  const ordered: Element[] = []
  const emitted = new Set<number>()
  const microsByApi = new Map<number, Element[]>()
  for (const member of members) {
    const apiId = ownership.get(member.id)
    if (apiId === undefined) continue
    const micros = microsByApi.get(apiId) ?? []
    micros.push(member)
    microsByApi.set(apiId, micros)
  }
  for (const member of members) {
    if (emitted.has(member.id) || ownership.has(member.id)) continue
    ordered.push(member)
    emitted.add(member.id)
    for (const micro of microsByApi.get(member.id) ?? []) {
      ordered.push(micro)
      emitted.add(micro.id)
    }
  }
  for (const member of members) if (!emitted.has(member.id)) ordered.push(member)
  return ordered
}

type GroupEntry = [string, Element[]]

/**
 * Ordena las bandas con barridos de mediana. El orden de los elementos se
 * obtiene de sus relaciones reales, no del id en el DSL; así las aristas de
 * una banda llegan aproximadamente al mismo orden en la siguiente banda.
 */
function crossingMinimizedGroups(
  groups: GroupEntry[],
  relationships: DiagramRelationship[],
  ownership: Map<number, number>,
): Map<string, Element[]> {
  const ordered = new Map<string, Element[]>()
  for (const [title, members] of groups) ordered.set(title, flowOrder(members, ownership))

  const position = new Map<number, number>()
  const refreshPositions = () => {
    groups.forEach(([title]) => {
      for (const [memberIndex, member] of (ordered.get(title) ?? []).entries()) position.set(member.id, memberIndex)
    })
  }
  const neighbors = (element: Element, acceptedGroups: Set<number>) => relationships.flatMap((relationship) => {
    const peer = relationship.source.id === element.id
      ? relationship.destination
      : relationship.destination.id === element.id ? relationship.source : undefined
    if (!peer) return []
    const peerGroup = groups.findIndex(([, members]) => members.some((member) => member.id === peer.id))
    return acceptedGroups.has(peerGroup) && position.has(peer.id) ? [position.get(peer.id)!] : []
  })
  const reorder = (groupIndexValue: number, acceptedGroups: Set<number>) => {
    const [title] = groups[groupIndexValue]
    const current = ordered.get(title) ?? []
    const original = new Map(current.map((element, index) => [element.id, index]))
    const scored = current.map((element) => {
      const values = neighbors(element, acceptedGroups)
      const score = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.POSITIVE_INFINITY
      return { element, score, original: original.get(element.id) ?? 0 }
    })
    scored.sort((left, right) => left.score - right.score || left.original - right.original)
    ordered.set(title, scored.map(({ element }) => element))
  }

  for (let pass = 0; pass < 8; pass += 1) {
    refreshPositions()
    for (let index = 1; index < groups.length; index += 1) reorder(index, new Set(Array.from({ length: index }, (_, value) => value)))
    refreshPositions()
    for (let index = groups.length - 2; index >= 0; index -= 1) reorder(index, new Set(Array.from({ length: groups.length - index - 1 }, (_, value) => value + index + 1)))
  }
  return ordered
}

function alignRoleToAnchors(
  items: Element[],
  anchors: Element[],
  relationships: DiagramRelationship[],
  ownership: Map<number, number>,
): Element[] {
  const anchorPosition = new Map(anchors.map((element, index) => [element.id, index]))
  const original = new Map(items.map((element, index) => [element.id, index]))
  const scores = items.map((element) => {
    const linked = new Set<number>()
    const owned = ownership.get(element.id)
    if (owned !== undefined && anchorPosition.has(owned)) linked.add(owned)
    for (const relationship of relationships) {
      if (relationship.source.id !== element.id && relationship.destination.id !== element.id) continue
      const peer = relationship.source.id === element.id ? relationship.destination : relationship.source
      if (anchorPosition.has(peer.id)) linked.add(peer.id)
    }
    const positions = [...linked].map((id) => anchorPosition.get(id)!).sort((left, right) => left - right)
    const score = positions.length ? positions.reduce((sum, value) => sum + value, 0) / positions.length : Number.POSITIVE_INFINITY
    return { element, score, original: original.get(element.id) ?? 0 }
  })
  scores.sort((left, right) => left.score - right.score || left.original - right.original)
  return scores.map(({ element }) => element)
}

function rowsFor(items: ItemSpec[], maxWidth = MAX_ROW_WIDTH): ItemSpec[][] {
  const rows: ItemSpec[][] = []
  let row: ItemSpec[] = []
  let width = 0
  for (const item of items) {
    const nextWidth = width + (row.length ? ITEM_GAP_X : 0) + item.width
    if (row.length && nextWidth > maxWidth) {
      rows.push(row)
      row = []
      width = 0
    }
    row.push(item)
    width += (row.length > 1 ? ITEM_GAP_X : 0) + item.width
  }
  if (row.length) rows.push(row)
  return rows
}

function sideForGroup(title: string): 'right' | null {
  if (/^service domain\s*-/i.test(title.trim())) return 'right'
  return null
}

function isAsync(relationship: DiagramRelationship): boolean {
  return relationship.technologies.some((value) => /event|amqp|topic/i.test(value))
    || relationship.descriptions.some((value) => /event|publish|subscribe|message/i.test(value))
}

function relationshipAction(relationship: DiagramRelationship): string {
  return [...new Set(relationship.descriptions.map((value) => value.trim()).filter(Boolean))].join(' · ')
}

function edgeGeometry(source: NodePosition, destination: NodePosition): EdgeGeometry {
  if (source.region !== 'main' && destination.region !== 'main' && source.region !== destination.region) {
    const forward = source.x < destination.x
    const sx = forward ? source.x + source.width : source.x
    const dx = forward ? destination.x : destination.x + destination.width
    const sy = source.y + source.height / 2 + verticalConnectionOffset(source, destination)
    const dy = destination.y + destination.height / 2 + verticalConnectionOffset(destination, source)
    const laneY = Math.min(source.y, destination.y) - 24
    const shoulder = forward ? 34 : -34
    return {
      d: `M ${sx} ${sy} C ${sx + shoulder} ${sy}, ${sx + shoulder} ${laneY}, ${sx + shoulder} ${laneY} L ${dx - shoulder} ${laneY} C ${dx - shoulder} ${laneY}, ${dx - shoulder} ${dy}, ${dx} ${dy}`,
      labelX: (sx + dx) / 2,
      labelY: laneY,
    }
  }
  const verticallySeparated = source.y + source.height < destination.y || destination.y + destination.height < source.y
  if (verticallySeparated) {
    const downward = source.y < destination.y
    const sourceOffset = connectionOffset(source, destination)
    const destinationOffset = connectionOffset(destination, source)
    const sx = source.x + source.width / 2 + sourceOffset
    const sy = downward ? source.y + source.height : source.y
    const dx = destination.x + destination.width / 2 + destinationOffset
    const dy = downward ? destination.y : destination.y + destination.height
    const middle = (sy + dy) / 2
    return {
      d: `M ${sx} ${sy} C ${sx} ${middle}, ${dx} ${middle}, ${dx} ${dy}`,
      labelX: (sx + dx) / 2,
      labelY: middle,
    }
  }

  const forward = source.x <= destination.x
  const sx = forward ? source.x + source.width : source.x
  const dx = forward ? destination.x : destination.x + destination.width
  const sy = source.y + source.height / 2 + verticalConnectionOffset(source, destination)
  const dy = destination.y + destination.height / 2 + verticalConnectionOffset(destination, source)
  const bend = Math.max(42, Math.abs(dx - sx) * 0.38)
  return {
    d: `M ${sx} ${sy} C ${sx + (forward ? bend : -bend)} ${sy}, ${dx + (forward ? -bend : bend)} ${dy}, ${dx} ${dy}`,
    labelX: (sx + dx) / 2,
    labelY: (sy + dy) / 2,
  }
}

function connectionOffset(position: NodePosition, peer: NodePosition): number {
  const range = Math.min(54, position.width * 0.2)
  const ratio = portRatio(position.element.id, peer.element.id, 17)
  return (ratio * 2 - 1) * range
}

function verticalConnectionOffset(position: NodePosition, peer: NodePosition): number {
  const range = Math.min(18, position.height * 0.2)
  const ratio = portRatio(position.element.id, peer.element.id, 43)
  return (ratio * 2 - 1) * range
}

function portRatio(positionId: number, peerId: number, salt: number): number {
  const mixed = (Math.imul(positionId + salt, 0x9e3779b1) ^ Math.imul(peerId + salt * 7, 0x5f356495)) >>> 0
  return mixed / 0xffffffff
}

function hash(text: string): number {
  let value = 0
  for (const character of text) value = ((value << 5) - value + character.charCodeAt(0)) | 0
  return Math.abs(value)
}

function domainHue(domain: string): number {
  if (/loan|repayment|prepayment/i.test(domain)) return 150
  if (/customer offer/i.test(domain)) return 202
  if (/transact/i.test(domain)) return 274
  if (/shared|parameter|util/i.test(domain)) return 38
  return [174, 218, 326, 18, 188, 258][hash(domain) % 6]
}

function domainColors(domain: string, dark: boolean) {
  const hue = domainHue(domain)
  return dark
    ? {
        border: `hsl(${hue} 62% 52%)`,
        api: `hsl(${hue} 24% 17%)`,
        micro: `hsl(${hue} 52% 25%)`,
      }
    : {
        border: `hsl(${hue} 52% 39%)`,
        api: `hsl(${hue} 40% 98%)`,
        micro: `hsl(${hue} 62% 88%)`,
      }
}

function topicColors(element: Element, dark: boolean) {
  const deadLetter = /dead[-. ]?letter|dlq/i.test(`${element.name} ${element.description}`)
  if (deadLetter) return dark
    ? { fill: '#35191b', border: '#ef6b70' }
    : { fill: '#fff0f0', border: '#bd3f45' }
  return dark
    ? { fill: '#30240f', border: '#dfa23b' }
    : { fill: '#fff4d9', border: '#ad7114' }
}

export function LayeredArchitecture({ workspace, view, dark, hostRef, onSize }: LayeredArchitectureProps) {
  const layout = useMemo(() => {
    const diagram = viewDiagram(workspace, view)
    const positions = new Map<number, NodePosition>()
    const bands: BandLayout[] = []
    const satelliteLabels: SatelliteLabel[] = []
    const ownership = ownershipFor(diagram.nodes, diagram.relationships)
    const grouped = new Map<string, Element[]>()
    for (const element of [...diagram.nodes].sort((left, right) => left.id - right.id)) {
      const name = architectureBandName(element)
      const members = grouped.get(name) ?? []
      members.push(element)
      grouped.set(name, members)
    }

    const orderedGroups = [...grouped].sort(([leftTitle, left], [rightTitle, right]) => {
      const leftOrder = architectureBandOrder(leftTitle, left)
      const rightOrder = architectureBandOrder(rightTitle, right)
      return leftOrder - rightOrder || left[0].id - right[0].id
    })

    const orderedMembers = crossingMinimizedGroups(orderedGroups, diagram.relationships, ownership)

    const prepareGroup = (title: string, members: Element[], maxRowWidth: number) => {
      const items = (orderedMembers.get(title) ?? flowOrder(members, ownership)).map(itemSpec)
      const apis = items.filter((item) => nodeKind(item.element) === 'api')
      const micros = alignRoleToAnchors(
        items.filter((item) => nodeKind(item.element) === 'microservice').map((item) => item.element),
        apis.map((item) => item.element),
        diagram.relationships,
        ownership,
      ).map(itemSpec)
      const topics = items.filter((item) => nodeKind(item.element) === 'topic')
      const support = items.filter((item) => !['api', 'microservice', 'topic'].includes(nodeKind(item.element)))
      const sideLeft = topics.length > 1 ? topics[0] : undefined
      const sideRight = topics.length ? topics[Math.min(1, topics.length - 1)] : undefined
      const sideWidth = (sideLeft ? sideLeft.width + TOPIC_SIDE_GAP : 0)
        + (sideRight ? sideRight.width + TOPIC_SIDE_GAP : 0)
      const sideCenterWidth = Math.max(STANDALONE_WIDTH, maxRowWidth - sideWidth)
      const attachRole = micros.length ? 'micro' : support.length ? 'support' : 'api'
      const rows: PreparedRow[] = []
      const addRoleRows = (role: 'api' | 'micro' | 'support', roleItems: ItemSpec[]) => {
        if (!roleItems.length) return
        const attachSides = role === attachRole && (sideLeft || sideRight)
        const roleRows = rowsFor(roleItems, attachSides ? sideCenterWidth : maxRowWidth)
        roleRows.forEach((row, rowIndex) => {
          const left = attachSides && rowIndex === 0 ? sideLeft : undefined
          const right = attachSides && rowIndex === 0 ? sideRight : undefined
          rows.push({
            center: row,
            left,
            right,
            height: Math.max(...row.map((item) => item.height), left?.height ?? 0, right?.height ?? 0),
            gapAfter: ITEM_GAP_Y,
          })
        })
      }
      addRoleRows('api', apis)
      addRoleRows('micro', micros)
      addRoleRows('support', support)
      const remainingTopics = topics.slice(sideLeft ? 2 : sideRight ? 1 : 0)
      rowsFor(remainingTopics, maxRowWidth).forEach((row) => rows.push({
        center: row,
        height: Math.max(...row.map((item) => item.height)),
        gapAfter: ITEM_GAP_Y,
      }))
      rows.forEach((row, index) => {
        if (index === rows.length - 1) row.gapAfter = 0
        else {
          const currentKinds = new Set(row.center.map((item) => nodeKind(item.element)))
          const nextKinds = new Set(rows[index + 1].center.map((item) => nodeKind(item.element)))
          if ((currentKinds.has('api') && nextKinds.has('microservice'))
            || (currentKinds.has('microservice') && nextKinds.has('function'))) row.gapAfter = ROLE_ROW_GAP
          if (nextKinds.has('topic')) row.gapAfter = EVENT_ROW_GAP
        }
      })
      const height = BAND_HEADER + BAND_INSET * 2
        + rows.reduce((sum, row) => sum + row.height + row.gapAfter, 0)
      return { title, members, rows, height }
    }

    const placeGroup = (
      prepared: ReturnType<typeof prepareGroup>,
      bandIndex: number,
      x: number,
      width: number,
      y: number,
      height = prepared.height,
      region: NodePosition['region'] = 'main',
      compact = false,
    ) => {
      if (!compact) bands.push({ id: `band-${bandIndex}`, title: prepared.title, x, y, width, height, count: prepared.members.length })
      const contentHeight = prepared.height - BAND_HEADER - BAND_INSET * 2
      let rowY = compact
        ? y + (height - contentHeight) / 2
        : y + BAND_HEADER + BAND_INSET + (height - prepared.height) / 2
      if (compact) {
        satelliteLabels.push({
          id: `satellite-${bandIndex}`,
          title: prepared.title,
          x,
          y: rowY - 18,
          width,
          count: prepared.members.length,
        })
      }
      prepared.rows.forEach((row) => {
        const contentX = compact ? x : x + BAND_INSET
        const contentWidth = compact ? width : width - BAND_INSET * 2
        const centerX = contentX + (row.left ? row.left.width + TOPIC_SIDE_GAP : 0)
        const centerWidth = contentWidth
          - (row.left ? row.left.width + TOPIC_SIDE_GAP : 0)
          - (row.right ? row.right.width + TOPIC_SIDE_GAP : 0)
        const rowWidth = row.center.reduce((sum, item) => sum + item.width, 0) + Math.max(0, row.center.length - 1) * ITEM_GAP_X
        let itemX = centerX + (centerWidth - rowWidth) / 2
        const placeItem = (item: ItemSpec, itemPositionX: number) => {
          const content = nodeContent(item.element, item.width)
          positions.set(item.element.id, {
            element: item.element, x: itemPositionX, y: rowY + (row.height - content.height) / 2, width: item.width,
            region, kind: nodeKind(item.element), domain: functionalDomain(item.element), ...content,
          })
        }
        if (row.left) placeItem(row.left, contentX)
        for (const item of row.center) {
          placeItem(item, itemX)
          itemX += item.width + ITEM_GAP_X
        }
        if (row.right) placeItem(row.right, contentX + contentWidth - row.right.width)
        rowY += row.height + row.gapAfter
      })
    }

    const mainGroups = orderedGroups.filter(([title]) => !sideForGroup(title))
    const satelliteGroups = orderedGroups.filter(([title]) => sideForGroup(title))
    const elementGroup = new Map<number, string>()
    for (const [title, members] of orderedGroups) {
      for (const member of members) elementGroup.set(member.id, title)
    }
    const satellitesByAnchor = new Map<string, { left: typeof orderedGroups; right: typeof orderedGroups }>()
    const resolvedSatelliteAnchors = new Map<string, string>()
    for (const satellite of satelliteGroups) {
      const [title, members] = satellite
      const memberIds = new Set(members.map((member) => member.id))
      const scores = new Map<string, number>()
      for (const relationship of diagram.relationships) {
        const sourceInside = memberIds.has(relationship.source.id)
        const destinationInside = memberIds.has(relationship.destination.id)
        if (sourceInside === destinationInside) continue
        const peer = sourceInside ? relationship.destination : relationship.source
        const peerGroup = elementGroup.get(peer.id)
        if (!peerGroup || !mainGroups.some(([mainTitle]) => mainTitle === peerGroup)) continue
        scores.set(peerGroup, (scores.get(peerGroup) ?? 0) + 1)
      }
      const inheritedAnchor = diagram.relationships.flatMap((relationship) => {
        const sourceInside = memberIds.has(relationship.source.id)
        const destinationInside = memberIds.has(relationship.destination.id)
        if (sourceInside === destinationInside) return []
        const peer = sourceInside ? relationship.destination : relationship.source
        const peerGroup = elementGroup.get(peer.id)
        const inherited = peerGroup ? resolvedSatelliteAnchors.get(peerGroup) : undefined
        return inherited ? [inherited] : []
      })[0]
      const anchor = [...scores].sort((left, right) => right[1] - left[1])[0]?.[0]
        ?? inheritedAnchor
        ?? mainGroups[0]?.[0]
      if (!anchor) continue
      resolvedSatelliteAnchors.set(title, anchor)
      const anchored = satellitesByAnchor.get(anchor) ?? { left: [], right: [] }
      anchored[sideForGroup(title) ?? 'right'].push(satellite)
      satellitesByAnchor.set(anchor, anchored)
    }

    let y = OUTER
    let bandSerial = 0
    mainGroups.forEach(([title, members]) => {
      const satellites = satellitesByAnchor.get(title) ?? { left: [], right: [] }
      const hasLeft = satellites.left.length > 0
      const hasRight = satellites.right.length > 0
      const mainX = OUTER + (hasLeft ? SIDECAR_WIDTH + SIDECAR_GAP : 0)
      const mainWidth = WIDTH - mainX - OUTER - (hasRight ? SIDECAR_WIDTH + SIDECAR_GAP : 0)
      const main = prepareGroup(title, members, mainWidth - BAND_INSET * 2)
      const left = satellites.left.map(([sideTitle, sideMembers]) =>
        prepareGroup(sideTitle, sideMembers, SIDECAR_WIDTH - BAND_INSET * 2))
      const right = satellites.right.map(([sideTitle, sideMembers]) =>
        prepareGroup(sideTitle, sideMembers, SIDECAR_WIDTH - BAND_INSET * 2))
      const stackHeight = (groups: typeof left) => groups.reduce((sum, group) => sum + group.height, 0)
        + Math.max(0, groups.length - 1) * SIDECAR_GAP
      const rowHeight = Math.max(main.height, stackHeight(left), stackHeight(right))

      const placeStack = (groups: typeof left, x: number) => {
        let sideY = y + (rowHeight - stackHeight(groups)) / 2
        groups.forEach((group) => {
          const height = groups.length === 1 ? rowHeight : group.height
          const region = x === OUTER ? 'left' : 'right'
          placeGroup(group, bandSerial++, x, SIDECAR_WIDTH, sideY, height, region, region === 'right')
          sideY += height + SIDECAR_GAP
        })
      }
      placeStack(left, OUTER)
      placeGroup(main, bandSerial++, mainX, mainWidth, y, rowHeight)
      placeStack(right, WIDTH - OUTER - SIDECAR_WIDTH)
      y += rowHeight + BAND_GAP
    })

    return {
      bands,
      satelliteLabels,
      positions,
      relationships: diagram.relationships.filter((relationship) => positions.has(relationship.source.id) && positions.has(relationship.destination.id)),
      height: Math.max(320, y - BAND_GAP + OUTER),
    }
  }, [workspace, view])

  useLayoutEffect(() => {
    onSize({ width: WIDTH, height: layout.height })
    return () => onSize(null)
  }, [layout.height, onSize])

  const colors = dark
    ? {
        band: '#101815', bandAlt: '#131c19', stroke: '#50665e', title: '#d0ddd8', subtitle: '#91a49d',
        line: '#91a19b', async: '#e0a33c', card: '#18211e', description: '#a9b9b3', labelBg: '#18211e', shadow: '#00000070',
      }
    : {
        band: '#f8fbf9', bandAlt: '#eef5f1', stroke: '#78978b', title: '#183b2f', subtitle: '#526c62',
        line: '#587168', async: '#985f06', card: '#ffffff', description: '#405e53', labelBg: '#ffffff', shadow: '#17382d2b',
      }

  return (
    <div ref={hostRef} className="diagram-host layered-architecture-host">
      <svg
        className="layered-architecture"
        width={WIDTH}
        height={layout.height}
        viewBox={`0 0 ${WIDTH} ${layout.height}`}
        role="img"
        aria-labelledby="layered-architecture-title layered-architecture-description"
      >
        <title id="layered-architecture-title">Arquitectura por bandas</title>
        <desc id="layered-architecture-description">Vista organizada usando grupos, elementos y relaciones declarados en el DSL.</desc>
        <defs>
          <marker id="layer-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={colors.line} />
          </marker>
          <marker id="layer-arrow-async" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={colors.async} />
          </marker>
          <filter id="layer-card-shadow" x="-20%" y="-30%" width="140%" height="170%">
            <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor={colors.shadow} />
          </filter>
        </defs>

        {layout.bands.map(({ id, title, x, y, width, height, count }, index) => (
          <g key={id} className="cluster architecture-band" data-layer={id}>
            <rect x={x} y={y} width={width} height={height} rx="8" fill={index % 2 ? colors.bandAlt : colors.band} stroke={colors.stroke} strokeWidth="1" />
            <text x={x + 22} y={y + 31} fill={colors.title} fontSize="17" fontWeight="650">{title}</text>
            <text x={x + width - 22} y={y + 31} fill={colors.subtitle} fontSize="12" textAnchor="end">{count} {count === 1 ? 'elemento' : 'elementos'}</text>
          </g>
        ))}

        {layout.satelliteLabels.map(({ id, title, x, y, width, count }) => (
          <g key={id} className="architecture-satellite-label">
            <text x={x} y={y} fill={colors.title} fontSize="13" fontWeight="650">{title}</text>
            <text x={x + width} y={y} fill={colors.subtitle} fontSize="11" textAnchor="end">{count} {count === 1 ? 'elemento' : 'elementos'}</text>
          </g>
        ))}

        <g className="architecture-connections" fill="none">
          {layout.relationships.map((relationship, index) => {
            const source = layout.positions.get(relationship.source.id)!
            const destination = layout.positions.get(relationship.destination.id)!
            const geometry = edgeGeometry(source, destination)
            const asynchronous = isAsync(relationship)
            const color = asynchronous ? colors.async : colors.line
            return (
              <path
                key={`${relationship.source.id}-${relationship.destination.id}-${index}`}
                className="flowchart-link"
                d={geometry.d}
                stroke={color}
                strokeWidth="1.35"
                strokeDasharray={asynchronous ? '7 6' : undefined}
                markerEnd={`url(#${asynchronous ? 'layer-arrow-async' : 'layer-arrow'})`}
                markerStart={relationship.bidirectional ? `url(#${asynchronous ? 'layer-arrow-async' : 'layer-arrow'})` : undefined}
                opacity="0.92"
              />
            )
          })}
        </g>

        <g className="architecture-nodes">
          {[...layout.positions.values()].map((position) => {
            const domain = domainColors(position.domain, dark)
            const topic = topicColors(position.element, dark)
            const isNew = isNewElement(position.element)
            const nameStart = position.y + 24 + (isNew ? 28 : 0)
            const descriptionStart = nameStart + (position.nameLines.length - 1) * 17 + 25
            const fill = position.kind === 'api' ? domain.api
              : position.kind === 'microservice' ? domain.micro
                : position.kind === 'topic' ? topic.fill : colors.card
            const stroke = position.kind === 'topic' ? topic.border : domain.border
            const radius = position.kind === 'function' ? 3 : 6
            return (
              <g key={position.element.id} className="node architecture-node" data-element-id={position.element.id}>
                {position.kind === 'topic' ? (
                  <path
                    d={`M ${position.x + 10} ${position.y} H ${position.x + position.width - 10} L ${position.x + position.width} ${position.y + 10} V ${position.y + position.height - 10} L ${position.x + position.width - 10} ${position.y + position.height} H ${position.x + 10} L ${position.x} ${position.y + position.height - 10} V ${position.y + 10} Z`}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth="1.25"
                    strokeDasharray="7 5"
                    filter="url(#layer-card-shadow)"
                  />
                ) : position.kind === 'microservice' ? (
                  <path
                    d={`M ${position.x + 34} ${position.y} H ${position.x + position.width - 34} L ${position.x + position.width} ${position.y + position.height / 2} L ${position.x + position.width - 34} ${position.y + position.height} H ${position.x + 34} L ${position.x} ${position.y + position.height / 2} Z`}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth="1.5"
                    filter="url(#layer-card-shadow)"
                  />
                ) : (
                  <rect
                    x={position.x}
                    y={position.y}
                    width={position.width}
                    height={position.height}
                    rx={radius}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={position.kind === 'api' ? '1.25' : '1'}
                    strokeDasharray={position.kind === 'function' ? '3 3' : undefined}
                    filter="url(#layer-card-shadow)"
                  />
                )}
                {isNew && (
                  <g className="architecture-node-badge" aria-label="New">
                    <rect
                      x={position.x + position.width - (position.kind === 'microservice' ? 88 : 58)}
                      y={position.y + 10}
                      width="46"
                      height="20"
                      rx="10"
                      fill="#facc15"
                      stroke="#a16207"
                      strokeWidth="1"
                    />
                    <text
                      x={position.x + position.width - (position.kind === 'microservice' ? 65 : 35)}
                      y={position.y + 24}
                      fill="#422006"
                      textAnchor="middle"
                      fontSize="10.5"
                      fontWeight="700"
                    >New</text>
                  </g>
                )}
                <text x={position.x + position.width / 2} y={nameStart} fill={colors.title} textAnchor="middle" fontSize="14" fontWeight="650">
                  {position.nameLines.map((line, lineIndex) => <tspan key={lineIndex} x={position.x + position.width / 2} dy={lineIndex ? 17 : 0}>{line}</tspan>)}
                </text>
                {position.descriptionLines.length > 0 && (
                  <text x={position.x + position.width / 2} y={descriptionStart} fill={colors.description} textAnchor="middle" fontSize="11.5">
                    {position.descriptionLines.map((line, lineIndex) => <tspan key={lineIndex} x={position.x + position.width / 2} dy={lineIndex ? 15 : 0}>{line}</tspan>)}
                  </text>
                )}
              </g>
            )
          })}
        </g>

        <g className="architecture-edge-labels" pointerEvents="none">
          {layout.relationships.map((relationship, index) => {
            const action = relationshipAction(relationship)
            if (!action) return null
            const source = layout.positions.get(relationship.source.id)!
            const destination = layout.positions.get(relationship.destination.id)!
            const geometry = edgeGeometry(source, destination)
            const lines = textLines(action, 28)
            const width = Math.max(...lines.map((line) => line.length), 1) * 6.4 + 18
            const height = lines.length * 13 + 10
            const asynchronous = isAsync(relationship)
            const stroke = asynchronous ? colors.async : colors.line
            return (
              <g key={`label-${relationship.source.id}-${relationship.destination.id}-${index}`}>
                <rect x={geometry.labelX - width / 2} y={geometry.labelY - height / 2} width={width} height={height} rx="4" fill={colors.labelBg} stroke={stroke} strokeWidth="0.75" />
                <text x={geometry.labelX} y={geometry.labelY - (lines.length - 1) * 6.5 + 4} fill={colors.title} textAnchor="middle" fontSize="11" fontWeight="600">
                  {lines.map((line, lineIndex) => <tspan key={lineIndex} x={geometry.labelX} dy={lineIndex ? 13 : 0}>{line}</tspan>)}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}

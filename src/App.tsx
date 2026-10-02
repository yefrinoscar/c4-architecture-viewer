import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useDocuments } from './useDocuments.ts'
import { DslEditor } from './diagram/DslEditor.tsx'
import { architectureBandName, CURVE_OPTIONS, isCurveMode, paletteFor, toMermaid, viewDiagram, type CurveMode } from './dsl/mermaid.ts'
import type { View } from './dsl/parse.ts'
import { Mermaid } from './diagram/Mermaid.tsx'
import { LayeredArchitecture } from './diagram/LayeredArchitecture.tsx'
import { AiChat } from './diagram/AiChat.tsx'
import { Tooltip } from './Tooltip.tsx'
import { EXPORT_FORMATS, downloadBlob, exportFileName, isExportFormat, svgToPng, textBlob, type ExportFormat } from './exportFiles.ts'
import { ZOOM_STEP, usePanZoom } from './usePanZoom.ts'
import './App.css'

type Level = 'G' | 'L1' | 'L2' | 'L3'

// El puente de IA (server/go-api.mjs) solo existe en dev, en preview y en `pnpm start`.
// En un build estático (Cloudflare Pages) no hay /api/ai/*, así que se oculta el asistente.
const AI_BRIDGE = import.meta.env.DEV || import.meta.env.VITE_AI_BRIDGE !== '0'

const UI_STATE_KEYS = {
  nav: 'c4-viewer:ui:nav-visible',
  editor: 'c4-viewer:ui:editor-visible',
  details: 'c4-viewer:ui:details-visible',
  focus: 'c4-viewer:ui:focus-mode',
} as const

function savedBoolean(key: string, fallback: () => boolean): boolean {
  if (typeof window === 'undefined') return fallback()
  try {
    const value = window.localStorage.getItem(key)
    if (value === 'true') return true
    if (value === 'false') return false
  } catch {
    // Usa el valor adaptable cuando el almacenamiento no está disponible.
  }
  return fallback()
}

interface Row {
  view: View
  key: string
  title: string
  kind: string
  kindLabel: string
  level: Level
  description: string
  lead: string
  audience: string[]
  purpose: string
  steps: { n: number; from: string; to: string; label: string }[]
  code: string
}

const LEVELS: { id: Level; eyebrow: string; hint: string }[] = [
  { id: 'G', eyebrow: 'Global', hint: 'Todo el modelo y sus relaciones' },
  { id: 'L1', eyebrow: 'L1 — Contexto', hint: 'Sistema y actores' },
  { id: 'L2', eyebrow: 'L2 — Contenedores', hint: 'Aplicaciones, stores e integraciones' },
  { id: 'L3', eyebrow: 'L3 — Componentes', hint: 'Contratos y colaboraciones internas' },
]

const KIND_LABEL: Record<string, string> = {
  global: 'Vista global',
  architectureLayers: 'Arquitectura por capas',
  architectureBands: 'Arquitectura por bandas',
  systemLandscape: 'Panorama',
  systemContext: 'Contexto',
  container: 'Contenedor',
  component: 'Componente',
  dynamic: 'Flujo dinámico',
}

const SUPPORTED = new Set(['systemContext', 'container', 'component', 'dynamic', 'systemLandscape'])

const LEGEND = [
  { label: 'Software System', color: '#0A523D', shape: 'square' },
  { label: 'Container / API', color: '#1D4CB8', shape: 'square' },
  { label: 'Component', color: '#63BEF2', shape: 'square' },
  { label: 'Microservice', color: '#23A2D9', shape: 'hex' },
  { label: 'Store / Topic', color: '#0E6B4F', shape: 'cylinder' },
  { label: 'Future (TO-BE)', color: '#7A5AC8', shape: 'dashed' },
  { label: 'Legacy', color: '#5F6C66', shape: 'square' },
  { label: 'Relación asíncrona', color: '#828282', shape: 'line' },
  { label: 'Error / dead-letter', color: '#D32F2F', shape: 'line' },
]

type GlobalKind = 'architectureBands' | 'architectureLayers'

const GLOBAL_VIEWS: { kind: GlobalKind; title: string; scope: string; lead: string; purpose: string }[] = [
  {
    kind: 'architectureBands',
    title: 'Arquitectura por bandas',
    scope: 'Grupos y sistemas declarados en el DSL',
    lead: 'Cada banda usa el último segmento de su group; los elementos sin group usan el nombre de su sistema padre.',
    purpose: 'Mostrar nombres, descripciones y relaciones del DSL sin agregar etiquetas arquitectónicas.',
  },
  {
    kind: 'architectureLayers',
    title: 'Arquitectura por capas',
    scope: 'Grupos, elementos y relaciones declarados en el DSL',
    lead: 'Mapa L2 que conserva los nombres y descripciones del DSL y agrupa por el último segmento de group.',
    purpose: 'Mostrar el modelo sin agregar nombres de capas ni acciones que no estén declaradas.',
  },
]

function globalView(kind: GlobalKind): View {
  return {
    type: kind,
    key: `__${kind}`,
    title: GLOBAL_VIEWS.find((entry) => entry.kind === kind)?.title ?? kind,
    description: '',
    includes: ['*'],
    excludes: [],
    steps: [],
  }
}

function levelFor(kind: string, scopeName?: string): Level {
  if (kind === 'global' || kind === 'systemLandscape') return 'G'
  if (kind === 'systemContext') return 'L1'
  if (kind === 'container') return 'L2'
  if (kind === 'component') return 'L3'
  if (!scopeName) return 'L1'
  return /Domain|System/.test(scopeName) ? 'L2' : 'L3'
}

function describe(description: string) {
  const audienceMatch = description.match(/Audiencia:\s*([\s\S]*?)(?:Propósito:|$)/i)
  const purposeMatch = description.match(/Propósito:\s*([\s\S]*)$/i)
  return {
    lead: description.split(/Audiencia:/i)[0].trim(),
    audience: audienceMatch
      ? audienceMatch[1].split(',').map((item) => item.trim()).filter(Boolean)
      : [],
    purpose: purposeMatch ? purposeMatch[1].trim() : '',
  }
}

function viewTitle(kind: string, key: string, title: string | undefined, scopeName?: string): string {
  if (title) return title
  if (kind === 'systemContext') return `System Context View: ${scopeName}`
  if (kind === 'container') return `Container View: ${scopeName}`
  if (kind === 'component') return `Component View: ${scopeName}`
  return key
}

function Icon({ name }: { name: string }) {
  const common = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const, focusable: false as const }
  switch (name) {
    case 'search':
      return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></svg>
    case 'minus':
      return <svg {...common}><path d="M5 12h14" /></svg>
    case 'plus':
      return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>
    case 'fit':
      return <svg {...common}><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" /></svg>
    case 'actual':
      return <svg {...common}><path d="M3 12h18" /><path d="M8 8H5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h3M16 8h3a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-3" /></svg>
    case 'download':
      return <svg {...common}><path d="M12 4v11m0 0 4-4m-4 4-4-4" /><path d="M5 19h14" /></svg>
    case 'upload':
      return <svg {...common}><path d="M12 20V9m0 0 4 4m-4-4-4 4" /><path d="M5 5h14" /></svg>
    case 'image':
      return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m4 16 4.5-4.5 3.5 3.5 2.5-2.5L20 17" /><circle cx="9" cy="9" r="1.4" /></svg>
    case 'chat':
      return <svg {...common}><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z" /><path d="M7 9h10M7 13h6" /></svg>
    case 'code':
      return <svg {...common}><path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16" /></svg>
    case 'moon':
      return <svg {...common}><path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" /></svg>
    case 'sun':
      return <svg {...common}><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></svg>
    case 'panel-right':
      return <svg {...common}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M14.5 4.5v15" /></svg>
    case 'focus':
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M3 12h3M18 12h3M12 3v3M12 18v3" /></svg>
    case 'fullscreen':
      return <svg {...common}><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></svg>
    case 'fullscreen-exit':
      return <svg {...common}><path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5" /></svg>
    case 'close':
      return <svg {...common}><path d="M6 6l12 12M18 6 6 18" /></svg>
    case 'chevron':
      return <svg {...common}><path d="m9 6 6 6-6 6" /></svg>
    case 'caret':
      return <svg {...common}><path d="m6 9 6 6 6-6" /></svg>
    case 'line':
      return <svg {...common}><path d="M4 18c6 0 10-12 16-12" /></svg>
    case 'panel-left':
      return <svg {...common}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9.5 4.5v15" /></svg>
    default:
      return null
  }
}

function ConnectMark({ size = 30 }: { size?: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const gradA = `connect-a-${uid}`
  const gradB = `connect-b-${uid}`
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradA} x1="2.5" y1="2.5" x2="9.5" y2="9.5" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0a4232" />
          <stop offset="1" stopColor="#0e5b44" />
        </linearGradient>
        <linearGradient id={gradB} x1="14.5" y1="14.5" x2="21.5" y2="21.5" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0e5b44" />
          <stop offset="1" stopColor="#2fa37c" />
        </linearGradient>
      </defs>
      <path d="M8.2 8.2 15.8 15.8" stroke="#0e5b44" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="6" cy="6" r="3.6" fill={`url(#${gradA})`} />
      <circle cx="18" cy="18" r="3.6" fill={`url(#${gradB})`} />
    </svg>
  )
}

export default function App() {
  const { documents, activeId, active, setActiveId, addFiles, updateText, selectView, closeDocument, markSaved, applyProposal, storageError } = useDocuments()
  const workspace = active?.workspace ?? null
  const selectedKey = active?.selectedKey ?? ''
  const error = active?.error
  const [search, setSearch] = useState({ id: activeId, text: '' })
  const query = search.id === activeId ? search.text : ''
  if (search.id !== activeId) setSearch({ id: activeId, text: '' })
  const [detailsOpen, setDetailsOpen] = useState(() => savedBoolean(UI_STATE_KEYS.details, () => typeof window !== 'undefined' && window.innerWidth > 1180))
  const [editorOpen, setEditorOpen] = useState(() => savedBoolean(UI_STATE_KEYS.editor, () => false))
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMounted, setChatMounted] = useState(false)
  const [focusMode, setFocusMode] = useState(() => savedBoolean(UI_STATE_KEYS.focus, () => false))
  const [fullscreen, setFullscreen] = useState(false)
  const [fullscreenError, setFullscreenError] = useState<string | null>(null)
  const [navVisible, setNavVisible] = useState(() => savedBoolean(UI_STATE_KEYS.nav, () => typeof window !== 'undefined' && window.innerWidth > 900))
  const [loading, setLoading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportMenu, setExportMenu] = useState(false)
  const [curveMenu, setCurveMenu] = useState(false)
  const [curve, setCurve] = useState<CurveMode>(() => {
    if (typeof window === 'undefined') return 'curve'
    const saved = window.localStorage.getItem('c4-viewer:curve')
    return isCurveMode(saved) ? saved : 'curve'
  })
  const [exportFormat, setExportFormat] = useState<ExportFormat>(() => {
    if (typeof window === 'undefined') return 'dsl'
    const saved = window.localStorage.getItem('c4-viewer:export-format')
    return isExportFormat(saved) ? saved : 'dsl'
  })
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window === 'undefined') return 'light'
    try {
      const saved = window.localStorage.getItem('c4-viewer:theme')
      if (saved === 'dark' || saved === 'light') return saved
    } catch {
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const searchRef = useRef<HTMLInputElement>(null)
  const stageRef = useRef<HTMLElement>(null)
  const focusSearch = useRef(false)

  useEffect(() => {
    const syncFullscreen = () => {
      setFullscreen(document.fullscreenElement === stageRef.current)
      if (!document.fullscreenElement) setFullscreenError(null)
    }
    document.addEventListener('fullscreenchange', syncFullscreen)
    return () => document.removeEventListener('fullscreenchange', syncFullscreen)
  }, [])

  const toggleFullscreen = useCallback(async () => {
    const stage = stageRef.current
    if (!stage) return
    try {
      if (document.fullscreenElement === stage) await document.exitFullscreen()
      else await stage.requestFullscreen()
      setFullscreenError(null)
    } catch (fullscreenFailure) {
      setFullscreenError(fullscreenFailure instanceof Error
        ? `No se pudo abrir la pantalla completa: ${fullscreenFailure.message}`
        : 'No se pudo abrir la pantalla completa.')
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      window.localStorage.setItem('c4-viewer:theme', theme)
    } catch {
      return
    }
  }, [theme])

  useEffect(() => {
    try {
      window.localStorage.setItem('c4-viewer:export-format', exportFormat)
    } catch {
      /* almacenamiento no disponible */
    }
  }, [exportFormat])

  useEffect(() => {
    try {
      window.localStorage.setItem('c4-viewer:curve', curve)
    } catch {
      /* almacenamiento no disponible */
    }
  }, [curve])

  useEffect(() => {
    try {
      window.localStorage.setItem(UI_STATE_KEYS.nav, String(navVisible))
      window.localStorage.setItem(UI_STATE_KEYS.editor, String(editorOpen))
      window.localStorage.setItem(UI_STATE_KEYS.details, String(detailsOpen))
      window.localStorage.setItem(UI_STATE_KEYS.focus, String(focusMode))
    } catch {
      /* almacenamiento no disponible */
    }
  }, [navVisible, editorOpen, detailsOpen, focusMode])

  useEffect(() => {
    if (!curveMenu) return
    const close = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('.curve-control')) return
      setCurveMenu(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCurveMenu(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [curveMenu])

  useEffect(() => {
    if (!exportMenu) return
    const close = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('.export-control')) return
      setExportMenu(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExportMenu(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [exportMenu])

  useEffect(() => {
    if (navVisible && !focusMode && focusSearch.current) {
      searchRef.current?.focus()
      focusSearch.current = false
    }
  }, [navVisible, focusMode])

  const togglePanel = useCallback((panel: 'nav' | 'editor' | 'details') => {
    const setVisible = panel === 'nav' ? setNavVisible : panel === 'editor' ? setEditorOpen : setDetailsOpen
    setVisible((value) => focusMode || !value)
    setFocusMode(false)
  }, [focusMode])

  // La identidad debe permanecer estable mientras cambia el zoom. Crear una
  // paleta nueva en cada render hacía que Mermaid reconstruyera el SVG entero
  // para cada evento de rueda.
  const diagramPalette = useMemo(() => paletteFor(theme), [theme])
  const newElementIds = useMemo(() => workspace?.elements
    .filter((element) => element.tags.some((tag) => tag.trim().toLowerCase() === 'new'))
    .map((element) => element.id) ?? [], [workspace])

  const rows = useMemo<Row[]>(() => {
    if (!workspace) return []
    const globalRows: Row[] = GLOBAL_VIEWS.map((entry) => ({
      view: globalView(entry.kind),
      key: globalView(entry.kind).key,
      title: entry.title,
      kind: entry.kind,
      kindLabel: KIND_LABEL[entry.kind] ?? entry.kind,
      level: 'G' as Level,
      description: entry.scope,
      lead: entry.lead,
      audience: ['arquitectura', 'integración'],
      purpose: entry.purpose,
      steps: [],
      code: toMermaid(workspace, globalView(entry.kind), diagramPalette),
    }))
    const declaredComponentScopes = new Set(
      workspace.views.filter((view) => view.type === 'component' && view.scope).map((view) => view.scope),
    )
    // L3 para cualquier contenedor con componentes, aunque el DSL no declare la vista.
    const componentRows: Row[] = workspace.elements
      .filter((element) => element.type === 'container'
        && element.children.some((child) => child.type === 'component')
        && !declaredComponentScopes.has(element))
      .map((element) => {
        const view: View = {
          type: 'component',
          key: `__l3-${element.varName}`,
          title: `L3 · ${element.name} · componentes`,
          description: `Componentes de ${element.name} y con quién colaboran.`,
          scope: element,
          includes: ['*'],
          excludes: [],
          steps: [],
        }
        return {
          view,
          key: view.key,
          title: view.title ?? view.key,
          kind: view.type,
          kindLabel: KIND_LABEL[view.type] ?? view.type,
          level: 'L3' as Level,
          description: view.description,
          lead: `Vista de componentes sintetizada por el visor para ${element.name}.`,
          audience: ['arquitectura', 'implementación'],
          purpose: 'Ver los contratos de este contenedor y a qué contenedores llama cada uno.',
          steps: [],
          code: toMermaid(workspace, view, diagramPalette),
        }
      })

    const viewRows = workspace.views
      .filter((view) => SUPPORTED.has(view.type) && (view.type === 'dynamic' || view.type === 'systemLandscape' || view.scope))
      .map((view) => {
        const info = describe(view.description)
        return {
          view,
          key: view.key,
          title: viewTitle(view.type, view.key, view.title, view.scope?.name),
          kind: view.type,
          kindLabel: KIND_LABEL[view.type] ?? view.type,
          level: levelFor(view.type, view.scope?.name),
          description: view.description,
          lead: info.lead,
          audience: info.audience,
          purpose: info.purpose,
          steps: view.steps.map((step) => ({
            n: step.n,
            from: step.source.name,
            to: step.destination.name,
            label: step.description,
          })),
          code: toMermaid(workspace, view, diagramPalette),
        }
      })
    return [...globalRows, ...viewRows, ...componentRows]
  }, [workspace, diagramPalette])

  const [urlView] = useState(() =>
    typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('view') ?? '',
  )

  const selected = rows.find((row) => row.key === selectedKey)
    ?? rows.find((row) => row.key === urlView)
    ?? rows.find((row) => row.level !== 'G')
    ?? rows[0]
  const selectedIndex = rows.findIndex((row) => row.key === selected?.key)

  const groups = useMemo(() => {
    const term = query.trim().toLowerCase()
    return LEVELS.map((level) => ({
      ...level,
      items: rows.filter(
        (row) =>
          row.level === level.id &&
          (term === '' ||
            row.title.toLowerCase().includes(term) ||
            row.description.toLowerCase().includes(term) ||
            row.steps.some((step) => step.label.toLowerCase().includes(term))),
      ),
    })).filter((group) => group.items.length > 0)
  }, [rows, query])

  const diagram = useMemo(
    () => (workspace && selected ? viewDiagram(workspace, selected.view) : null),
    [workspace, selected],
  )
  const upwardApiEdges = useMemo(() => {
    if (selected?.kind !== 'architectureLayers' || !diagram) return []
    return diagram.relationships
      .filter(({ source, destination }) =>
        /^system\s*\(sys\)$/i.test(architectureBandName(source))
        && destination.type === 'component'
        && destination.parent?.tags.some((tag) => tag.trim().toLowerCase() === 'api'))
      .map(({ source, destination }) => ({ source: source.id, destination: destination.id }))
  }, [diagram, selected])

  const { containerRef, hostRef, transform, handlers, fit, zoomBy, actualSize, setNatural, reset } = usePanZoom()
  const onSize = setNatural

  useEffect(() => {
    reset()
  }, [activeId, selectedKey, reset])

  const select = useCallback((key: string) => {
    if (!activeId) return
    selectView(activeId, key)
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `?view=${encodeURIComponent(key)}`)
    }
  }, [activeId, selectView])

  const goTo = useCallback(
    (index: number) => {
      if (!rows.length) return
      const next = (index + rows.length) % rows.length
      select(rows[next].key)
    },
    [rows, select],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.isContentEditable || target?.closest('.cm-editor, [contenteditable], input, textarea, button, select, a, summary, [role="button"]')) return
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowRight':
        case 'PageDown':
          event.preventDefault()
          goTo(selectedIndex + 1)
          break
        case 'ArrowUp':
        case 'ArrowLeft':
        case 'PageUp':
          event.preventDefault()
          goTo(selectedIndex - 1)
          break
        case '+':
        case '=':
          event.preventDefault()
          zoomBy(ZOOM_STEP)
          break
        case '-':
        case '_':
          event.preventDefault()
          zoomBy(1 / ZOOM_STEP)
          break
        case '0':
          event.preventDefault()
          fit()
          break
        case 'f':
        case 'F':
          event.preventDefault()
          if (event.shiftKey) void toggleFullscreen()
          else setFocusMode((value) => !value)
          break
        case 'b':
        case 'B':
          event.preventDefault()
          togglePanel('nav')
          break
        case '/':
          event.preventDefault()
          focusSearch.current = true
          setFocusMode(false)
          setNavVisible(true)
          if (searchRef.current) {
            searchRef.current.focus()
            focusSearch.current = false
          }
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fit, goTo, selectedIndex, toggleFullscreen, togglePanel, zoomBy])

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!files.length) return
    setLoading(true)
    setUploadError(null)
    try {
      await addFiles(files)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const downloadDsl = () => {
    if (!active) return
    downloadBlob(textBlob(active.text, 'text/plain'), exportFileName(active.name, 'dsl'))
    markSaved(active.id)
  }

  const exportCurrent = async (format: ExportFormat) => {
    if (format === 'dsl') {
      downloadDsl()
      return
    }
    const svg = containerRef.current?.querySelector('svg')
    if (!svg) {
      setExportError('No hay un diagrama renderizado para exportar.')
      return
    }
    try {
      if (format === 'svg') {
        downloadBlob(textBlob(new XMLSerializer().serializeToString(svg), 'image/svg+xml'), exportFileName(active?.name, 'svg', selected?.key))
      } else {
        const blob = await svgToPng(svg)
        downloadBlob(blob, exportFileName(active?.name, 'png', selected?.key))
      }
      setExportError(null)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'No se pudo exportar el diagrama.')
    }
  }

  const chooseFormat = (format: ExportFormat) => {
    setExportFormat(format)
    setExportMenu(false)
    void exportCurrent(format)
  }

  const zoomPercent = Math.round(transform.scale * 100)
  const currentFormat = EXPORT_FORMATS.find((format) => format.id === exportFormat) ?? EXPORT_FORMATS[0]
  const currentCurve = CURVE_OPTIONS.find((option) => option.id === curve) ?? CURVE_OPTIONS[0]

  return (
    <div className={chatOpen && !focusMode ? 'app chat-open' : 'app'}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <ConnectMark />
          </span>
          <div className="brand-text">
            <strong>{workspace?.name ?? 'Atlas C4'}</strong>
            <span>{workspace?.description ?? 'Structurizr DSL · sin modelo cargado'}</span>
          </div>
        </div>
        <div className="topbar-meta" role="group" aria-label="Herramientas">
          <div className="toolbar-cluster" role="group" aria-label="Paneles">
            <Tooltip label="Índice" detail="Vistas y elementos del modelo. Atajo: B.">
              <button className="icon-btn panel-toggle" onClick={() => togglePanel('nav')} aria-label="Índice" aria-pressed={!focusMode && navVisible}>
                <Icon name="panel-left" />
              </button>
            </Tooltip>
            <Tooltip label="Editor DSL" detail="Edita la fuente del documento con vista previa en vivo.">
              <button className="icon-btn panel-toggle" onClick={() => togglePanel('editor')} aria-label="Editor DSL" aria-pressed={!focusMode && editorOpen} disabled={!active}>
                <Icon name="code" />
              </button>
            </Tooltip>
            <Tooltip label="Detalles" detail="Descripción, relaciones y pasos de la vista activa.">
              <button className="icon-btn panel-toggle" onClick={() => togglePanel('details')} aria-label="Detalles" aria-pressed={!focusMode && detailsOpen}>
                <Icon name="panel-right" />
              </button>
            </Tooltip>
            {AI_BRIDGE && (
              <Tooltip label="Asistente IA" detail="Pregunta o pide cambios al modelo. Propone, nunca aplica solo.">
                <button className="icon-btn" aria-label="Asistente IA" aria-pressed={chatOpen && !focusMode} onClick={() => { setChatMounted(true); setChatOpen((value) => focusMode || !value); setFocusMode(false) }}>
                  <Icon name="chat" />
                </button>
              </Tooltip>
            )}
          </div>
          <span className="toolbar-separator" aria-hidden="true" />
          <div className="toolbar-cluster" role="group" aria-label="Vista">
            <Tooltip label="Modo enfoque" detail="Oculta los paneles y deja solo el diagrama. Atajo: F.">
              <button className="icon-btn" onClick={() => setFocusMode((value) => !value)} aria-label="Modo enfoque" aria-pressed={focusMode}>
                <Icon name="focus" />
              </button>
            </Tooltip>
            <Tooltip label={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'} detail="Alterna claro y oscuro; se recuerda tu elección.">
              <button className="icon-btn" onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')} aria-label="Tema oscuro" aria-pressed={theme === 'dark'}>
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
              </button>
            </Tooltip>
          </div>
          <span className="toolbar-separator" aria-hidden="true" />
          <div className="toolbar-cluster" role="group" aria-label="Archivo">
            <div className="export-control">
              <Tooltip label={`Descargar ${currentFormat.label}`} detail={`Predeterminado: ${currentFormat.label} · ${currentFormat.hint}.`}>
                <button
                  className="icon-btn export-main"
                  onClick={() => { void exportCurrent(exportFormat) }}
                  aria-label={`Descargar ${currentFormat.label}`}
                  disabled={exportFormat === 'dsl' ? !active : !selected}
                >
                  <Icon name="download" />
                  <span className="export-main-format" aria-hidden="true">{currentFormat.label}</span>
                </button>
              </Tooltip>
              <Tooltip label="Formato de descarga" detail={`Elige DSL, PNG o SVG y quedará como predeterminado. Hoy: ${currentFormat.label}.`}>
                <button
                  className="icon-btn export-caret"
                  onClick={() => setExportMenu((value) => !value)}
                  aria-label="Formato de descarga"
                  aria-haspopup="menu"
                  aria-expanded={exportMenu}
                >
                  <Icon name="caret" />
                </button>
              </Tooltip>
              {exportMenu && (
                <div className="export-menu" role="menu" aria-label="Formato de descarga">
                  <p className="export-menu-title">Formato de descarga</p>
                  {EXPORT_FORMATS.map((format) => (
                    <button
                      key={format.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={format.id === exportFormat}
                      className={format.id === exportFormat ? 'export-option is-default' : 'export-option'}
                      onClick={() => chooseFormat(format.id)}
                    >
                      <span className="export-option-main">
                        <strong>{format.label}</strong>
                        <span className="export-option-extension">{format.extension}</span>
                      </span>
                      <span className="export-option-hint">
                        {format.hint}
                        {format.id === exportFormat && <em className="export-option-default">Predeterminado</em>}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Tooltip label="Cargar .dsl" detail="Abre uno o varios archivos de Structurizr DSL.">
              <label className="icon-btn upload-control" htmlFor="dsl-file-input">
                <Icon name="upload" />
                <input
                  id="dsl-file-input"
                  type="file"
                  accept=".dsl,.txt"
                  multiple
                  onChange={onFile}
                  disabled={loading}
                  aria-label="Cargar archivos DSL"
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' }}
                  onFocus={(event) => { event.currentTarget.parentElement!.style.outline = '2px solid var(--accent)' }}
                  onBlur={(event) => { event.currentTarget.parentElement!.style.outline = '' }}
                />
              </label>
            </Tooltip>
          </div>
        </div>
      </header>

      <div className="documents-bar" role="group" aria-label="Documentos abiertos" style={{ display: 'flex', overflowX: 'auto', flexShrink: 0 }}>
        <span className="documents-count" style={{ whiteSpace: 'nowrap' }}>{documents.length} documentos</span>
        {documents.map((doc) => (
          <div key={doc.id} className={`document-tab${doc.id === activeId ? ' is-active' : ''}`} style={{ display: 'flex', flexShrink: 0 }}>
            <button
              className="document-switch"
              title={doc.name}
              aria-label={`${doc.name}${doc.dirty ? ', cambios sin descargar' : ''}`}
              aria-current={doc.id === activeId ? true : undefined}
              onClick={() => setActiveId(doc.id)}
            >
              <span>{doc.name}</span>
              {doc.dirty && <span className="document-dirty" aria-hidden="true"> *</span>}
            </button>
            <button className="icon-btn document-close" onClick={() => closeDocument(doc.id)} title={`Cerrar ${doc.name}`} aria-label={`Cerrar ${doc.name}`}>
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
      {loading && <div className="loading-status" role="status">Cargando archivos DSL…</div>}
      {uploadError && <div className="storage-error" role="alert">{uploadError}</div>}
      {exportError && <div className="storage-error" role="alert">{exportError}</div>}
      {fullscreenError && <div className="storage-error" role="alert">{fullscreenError}</div>}
      {storageError && <div className="storage-error" role="alert">{storageError}</div>}

      <div className="workspace" aria-busy={loading}>
        <div className={`scrim${!focusMode && navVisible ? ' is-visible' : ''}`} onClick={() => setNavVisible(false)} aria-hidden="true" />
        {!focusMode && navVisible && (
        <aside className="sidebar is-open" aria-label="Índice de vistas">
          <label className="search">
            <Icon name="search" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setSearch({ id: activeId, text: event.target.value })}
              aria-label="Buscar vista, flujo o paso"
              placeholder="Buscar vista, flujo o paso…"
              spellCheck={false}
            />
            <kbd>/</kbd>
          </label>

          <nav className="nav">
            {groups.map((group) => (
              <section key={group.id} className="nav-group">
                <div className="nav-group-head">
                  <span className="nav-eyebrow">{group.eyebrow}</span>
                  <span className="nav-hint">{group.hint}</span>
                </div>
                <ul>
                  {group.items.map((row) => (
                    <li key={row.key}>
                      <button
                        className={`nav-item${row.key === selected?.key ? ' is-active' : ''}`}
                        aria-current={row.key === selected?.key ? true : undefined}
                        onClick={() => {
                          select(row.key)
                          if (window.innerWidth <= 900) setNavVisible(false)
                        }}
                      >
                        <span className="nav-item-main">
                          <span className="nav-item-title">{row.title}</span>
                          <span className="nav-item-sub">
                            {row.kindLabel}
                            {row.steps.length ? ` · ${row.steps.length} pasos` : ''}
                            {row.key === selected?.key && <span className="current-view"> · Actual</span>}
                          </span>
                        </span>
                        <Icon name="chevron" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {rows.length === 0 && <p className="nav-empty">No hay vistas que mostrar.</p>}
            {rows.length > 0 && groups.length === 0 && <p className="nav-empty">Sin resultados para “{query}”.</p>}
          </nav>
        </aside>
        )}

        {documents.map((doc) => (
          <section key={doc.id} className="editor-panel" hidden={focusMode || !editorOpen || doc.id !== activeId} aria-label={`Editor de ${doc.name}`}>
            <div className="editor-heading"><strong>{doc.name}</strong><span>DSL</span></div>
            <DslEditor text={doc.text} onChange={(text) => updateText(doc.id, text)} dark={theme === 'dark'} />
            <div className="editor-status" role="status">
              {doc.error ?? (doc.text !== doc.validText ? 'Validando…' : 'Validación estructural correcta')}
              <small>Vista previa automática · ⌘/Ctrl F buscar · Ctrl Espacio completar. No sustituye la validación de Structurizr.</small>
            </div>
          </section>
        ))}
        <main className="stage" ref={stageRef}>
          {error && workspace && (
            <div className="stage-error" role="alert">
              <span>{error} · Mostrando la última versión válida.</span>
            </div>
          )}
          {selected && (
            <div className="stage-toolbar">
              <div className="toolbar-group">
                <Tooltip label="Alejar" detail="Reduce el zoom. Atajo: −">
                  <button className="icon-btn" onClick={() => zoomBy(1 / ZOOM_STEP)} aria-label="Alejar"><Icon name="minus" /></button>
                </Tooltip>
                <span className="zoom-value">{zoomPercent}%</span>
                <Tooltip label="Acercar" detail="Aumenta el zoom. Atajo: +">
                  <button className="icon-btn" onClick={() => zoomBy(ZOOM_STEP)} aria-label="Acercar"><Icon name="plus" /></button>
                </Tooltip>
              </div>
              <div className="toolbar-group">
                <Tooltip label="Ajustar" detail="Encaja el diagrama completo en la pantalla. Atajo: 0">
                  <button className="tool-btn" onClick={fit}><Icon name="fit" /> <span>Ajustar</span></button>
                </Tooltip>
                <Tooltip label="Tamaño real" detail="Vuelve al 100% y centra el diagrama.">
                  <button className="tool-btn" onClick={actualSize}><Icon name="actual" /> <span>1:1</span></button>
                </Tooltip>
                <Tooltip label={fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'} detail="Amplía el canvas a toda la pantalla. Atajo: Mayús + F; Esc para salir.">
                  <button className="tool-btn" onClick={() => { void toggleFullscreen() }} aria-label={fullscreen ? 'Salir de pantalla completa' : 'Abrir pantalla completa'} aria-pressed={fullscreen} disabled={!document.fullscreenEnabled}>
                    <Icon name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} /> <span>{fullscreen ? 'Salir' : 'Pantalla completa'}</span>
                  </button>
                </Tooltip>
              </div>
              <div className="toolbar-group">
                <div className="curve-control">
                  <Tooltip label="Trazado de líneas" detail={`${currentCurve.label}: ${currentCurve.hint}.`}>
                    <button
                      className="tool-btn"
                      onClick={() => setCurveMenu((value) => !value)}
                      aria-label="Trazado de líneas"
                      aria-haspopup="menu"
                      aria-expanded={curveMenu}
                    >
                      <Icon name="line" />
                      <span>{currentCurve.label}</span>
                      <Icon name="caret" />
                    </button>
                  </Tooltip>
                  {curveMenu && (
                    <div className="tool-menu" role="menu" aria-label="Trazado de líneas">
                      {CURVE_OPTIONS.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={option.id === curve}
                          className={option.id === curve ? 'tool-menu-option is-active' : 'tool-menu-option'}
                          onClick={() => { setCurve(option.id); setCurveMenu(false) }}
                        >
                          <span className="tool-menu-main"><strong>{option.label}</strong></span>
                          <span className="tool-menu-hint">{option.hint}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="canvas" ref={containerRef} {...handlers}>
            {!workspace && (
              <div className="canvas-empty">
                <span className="empty-mark"><ConnectMark size={44} /></span>
                <p className="empty-title">
                  {error ? 'No se pudo cargar el modelo' : 'Sin modelo cargado'}
                </p>
                {error && <pre className="empty-error">{error}</pre>}
                <p className="empty-copy">
                  Selecciona un archivo <code>.dsl</code> de Structurizr.
                </p>
                <div className="empty-actions">
                  <label className="btn-primary" htmlFor="dsl-file-input">
                    <span className="btn-label">Cargar .dsl</span>
                    <span className="btn-ic"><Icon name="upload" /></span>
                  </label>
                </div>
              </div>
            )}
            {selected?.kind === 'architectureBands' && workspace
              ? <LayeredArchitecture key={`${activeId}:${selected.key}`} workspace={workspace} view={selected.view} dark={theme === 'dark'} hostRef={hostRef} onSize={onSize} />
              : selected && <Mermaid key={`${activeId}:${selected.key}`} code={selected.code} curve={curve} spacing={selected.kind === 'architectureLayers' ? 'normal' : selected.level === 'G' || (diagram?.relationships.length ?? 0) >= 8 ? 'spacious' : 'normal'} nativeEdgeLabels={selected.kind === 'architectureLayers'} upwardApiEdges={upwardApiEdges} newElementIds={newElementIds} palette={diagramPalette} hostRef={hostRef} onSize={onSize} />}
          </div>

          {selected && (
            <div className="titleblock">
              <span className="tb-lv">{selected.level}</span>
              <span className="tb-title">{selected.title}</span>
              <span className="tb-sep" />
              <span className="tb-meta">{String(selectedIndex + 1).padStart(2, '0')}/{rows.length}</span>
              <span className="tb-sep" />
              <span className="tb-meta">{zoomPercent}%</span>
            </div>
          )}
        </main>

        {!focusMode && (
        <aside className={`details${detailsOpen ? ' is-open' : ''}`}>
          <div className="details-scroll">
            {selected ? (
              <>
                <div className="details-head">
                  <span className="lv">{selected.level}</span>
                  <span className="kind-chip">{selected.kindLabel}</span>
                </div>
                <h2>{selected.title}</h2>
                {selected.lead && <p className="details-lead">{selected.lead}</p>}

                {selected.purpose && (
                  <div className="details-section">
                    <h3>Propósito</h3>
                    <p>{selected.purpose}</p>
                  </div>
                )}

                {selected.audience.length > 0 && (
                  <div className="details-section">
                    <h3>Audiencia</h3>
                    <div className="chips">
                      {selected.audience.map((item) => (
                        <span key={item} className="chip">{item}</span>
                      ))}
                    </div>
                  </div>
                )}

                {selected.steps.length > 0 && (
                  <div className="details-section">
                    <h3>Secuencia</h3>
                    <ol className="steps">
                      {selected.steps.map((step) => (
                        <li key={step.n}>
                          <span className="step-n">{step.n}</span>
                          <span className="step-body">
                            <span className="step-flow">
                              <b>{step.from}</b>
                              <span className="step-arrow">→</span>
                              <b>{step.to}</b>
                            </span>
                            <span className="step-label">{step.label}</span>
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </>
            ) : (
              <div className="details-head">
                <span className="kind-chip">Sin vista</span>
              </div>
            )}

            {diagram && diagram.relationships.length > 0 && (
              <div className="details-section">
                <h3>Relaciones <span className="count">{diagram.relationships.length}</span></h3>
                <ul className="rel-list">
                  {diagram.relationships.map((rel) => (
                    <li key={`${rel.source.id}-${rel.destination.id}`}>
                      <p className="rel-flow">
                        <b>{rel.source.name}</b>
                        <span aria-hidden="true">{rel.bidirectional ? '↔' : '→'}</span>
                        <b>{rel.destination.name}</b>
                      </p>
                      <p className="rel-meta">
                        {rel.descriptions.join(' · ') || 'sin descripción'}
                        {rel.technologies.length > 0 && <span> · [{rel.technologies.join(', ')}]</span>}
                        {rel.count > 1 && <span> · {rel.count} relaciones</span>}
                      </p>
                      {rel.endpoints.length > 0 && (
                        <ul className="rel-endpoints">
                          {rel.endpoints.map((endpoint) => <li key={endpoint}><code>{endpoint}</code></li>)}
                        </ul>
                      )}
                      {rel.properties.filter((property) => property.name !== 'endpoints').map((property) => (
                        <p key={property.name} className="rel-prop">
                          <span>{property.name}</span> {property.values.join(' · ')}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <details className="legend" open>
              <summary>Leyenda</summary>
              <ul>
                {LEGEND.map((item) => (
                  <li key={item.label}>
                    <span
                      className={`swatch swatch-${item.shape}`}
                      style={{ background: item.shape === 'dashed' ? 'transparent' : item.color, borderColor: item.color, color: item.color }}
                    />
                    {item.label}
                  </li>
                ))}
              </ul>
            </details>

            <div className="details-foot">
              <span>Renderizado desde el DSL</span>
              <span>{workspace ? `${workspace.elements.length} elementos · ${workspace.relationships.length} relaciones` : '—'}</span>
            </div>
          </div>
        </aside>
        )}
        {AI_BRIDGE && chatMounted && <AiChat document={active} hidden={!chatOpen || focusMode} onClose={() => setChatOpen(false)} onApply={applyProposal} />}
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { validateDsl } from './diagram/DslEditor.tsx'
import { parseWorkspace } from './dsl/parse.ts'
import type { Workspace } from './dsl/parse.ts'

export interface DslDocument {
  id: string
  name: string
  text: string
  validText: string
  workspace: Workspace | null
  error: string | null
  selectedKey: string
  dirty: boolean
}

type SavedDocument = Omit<DslDocument, 'workspace'>

interface DocumentState {
  documents: DslDocument[]
  activeId: string | null
}

const STORAGE_KEY = 'c4-viewer:documents:v2'
const LEGACY_KEY = 'c4-viewer:dsl:v1'
const GENERATED_VIEW_KEYS = new Set([
  '__architectureBands',
  '__architectureLayers',
])

function validSelectedKey(workspace: Workspace, key: string): boolean {
  return GENERATED_VIEW_KEYS.has(key) || workspace.views.some((view) => view.key === key)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parse(text: string): Workspace {
  const error = validateDsl(text)
  if (error) throw new Error(error)
  return parseWorkspace(text)
}

function validateDocument(document: DslDocument): DslDocument {
  try {
    const workspace = parse(document.text)
    return {
      ...document,
      validText: document.text,
      workspace,
      error: null,
      selectedKey: validSelectedKey(workspace, document.selectedKey)
        ? document.selectedKey
        : '',
    }
  } catch (error) {
    return { ...document, error: errorMessage(error) }
  }
}

function createDocument(name: string, text: string): DslDocument {
  return {
    id: crypto.randomUUID(),
    name,
    text,
    validText: '',
    workspace: null,
    error: null,
    selectedKey: '',
    dirty: false,
  }
}

function isSavedDocument(value: unknown): value is SavedDocument {
  if (!value || typeof value !== 'object') return false
  const document = value as Record<string, unknown>
  return typeof document.id === 'string' && document.id.length > 0
    && typeof document.name === 'string'
    && typeof document.text === 'string'
    && typeof document.validText === 'string'
    && (document.error === null || typeof document.error === 'string')
    && typeof document.selectedKey === 'string'
    && typeof document.dirty === 'boolean'
}

function restoreDocument(saved: SavedDocument): DslDocument {
  const document: DslDocument = {
    id: saved.id,
    name: saved.name,
    text: saved.text,
    validText: saved.validText,
    workspace: null,
    error: saved.error,
    selectedKey: saved.selectedKey,
    dirty: saved.dirty,
  }
  if (document.validText) {
    try {
      document.workspace = parse(document.validText)
      if (!validSelectedKey(document.workspace, document.selectedKey)) {
        document.selectedKey = ''
      }
    } catch (error) {
      document.error = errorMessage(error)
    }
  }
  return document
}

function readSaved(): DocumentState & { storageError: string | null; needsSave: boolean } {
  const empty = { documents: [], activeId: null, storageError: null, needsSave: false }
  if (typeof window === 'undefined') return empty
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw !== null) {
      const saved: unknown = JSON.parse(raw)
      if (!saved || typeof saved !== 'object') throw new Error('Invalid documents storage format.')
      const value = saved as Record<string, unknown>
      if (!Array.isArray(value.documents) || !value.documents.every(isSavedDocument)
        || (value.activeId !== null && typeof value.activeId !== 'string')) {
        throw new Error('Invalid documents storage format.')
      }
      const documents = value.documents.map(restoreDocument)
      if (new Set(documents.map((document) => document.id)).size !== documents.length) {
        throw new Error('Duplicate document IDs in storage.')
      }
      const activeId = documents.some((document) => document.id === value.activeId)
        ? value.activeId as string
        : documents[0]?.id ?? null
      return { documents, activeId, storageError: null, needsSave: false }
    }
    const legacy = window.localStorage.getItem(LEGACY_KEY)
    if (legacy === null) return empty
    const saved: unknown = JSON.parse(legacy)
    if (!saved || typeof saved !== 'object'
      || !('name' in saved) || typeof saved.name !== 'string'
      || !('text' in saved) || typeof saved.text !== 'string') {
      throw new Error('Invalid legacy document storage format.')
    }
    const document = validateDocument(createDocument(saved.name, saved.text))
    return { documents: [document], activeId: document.id, storageError: null, needsSave: true }
  } catch (error) {
    return { ...empty, storageError: `Unable to load documents: ${errorMessage(error)}` }
  }
}

export function useDocuments() {
  const [boot] = useState(readSaved)
  const [state, setState] = useState<DocumentState>({ documents: boot.documents, activeId: boot.activeId })
  const [storageError, setStorageError] = useState<string | null>(boot.storageError)
  const current = useRef(state)
  const mounted = useRef(false)
  const pendingSave = useRef(boot.needsSave)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const validationTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const pendingValidation = useRef(new Set(boot.documents
    .filter((document) => document.text !== document.validText && (document.text !== '' || document.dirty))
    .map((document) => document.id)))

  const flush = useCallback(() => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = null
    if (!pendingSave.current || typeof window === 'undefined') return
    try {
      const documents: SavedDocument[] = current.current.documents.map((document) => ({
        id: document.id,
        name: document.name,
        text: document.text,
        validText: document.validText,
        error: document.error,
        selectedKey: document.selectedKey,
        dirty: document.dirty,
      }))
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ documents, activeId: current.current.activeId }))
      pendingSave.current = false
      if (mounted.current) setStorageError(null)
    } catch (error) {
      if (mounted.current) setStorageError(`Unable to save documents: ${errorMessage(error)}`)
    }
  }, [])

  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flush, 600)
  }, [flush])

  const change = useCallback((next: DocumentState) => {
    current.current = next
    setState(next)
    pendingSave.current = true
    scheduleSave()
  }, [scheduleSave])

  const scheduleValidation = useCallback((id: string) => {
    const previous = validationTimers.current.get(id)
    if (previous !== undefined) clearTimeout(previous)
    pendingValidation.current.add(id)
    validationTimers.current.set(id, setTimeout(() => {
      validationTimers.current.delete(id)
      pendingValidation.current.delete(id)
      const latest = current.current
      const document = latest.documents.find((item) => item.id === id)
      if (!document) return
      const validated = validateDocument(document)
      change({ ...latest, documents: latest.documents.map((item) => item.id === id ? validated : item) })
    }, 400))
  }, [change])

  useEffect(() => {
    mounted.current = true
    for (const id of pendingValidation.current) scheduleValidation(id)
    if (pendingSave.current) scheduleSave()
    window.addEventListener('pagehide', flush)
    const timers = validationTimers.current
    return () => {
      window.removeEventListener('pagehide', flush)
      mounted.current = false
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      flush()
    }
  }, [flush, scheduleSave, scheduleValidation])

  const setActiveId = useCallback((id: string | null) => {
    const latest = current.current
    if (id === latest.activeId) return
    if (id === null ? latest.documents.length > 0 : !latest.documents.some((document) => document.id === id)) return
    change({ ...latest, activeId: id })
  }, [change])

  const addFiles = useCallback(async (files: File[]): Promise<void> => {
    const batch = files.map((file) => ({ file, document: createDocument(file.name, '') }))
    const results = await Promise.allSettled(batch.map(async ({ file }) => file.text()))
    if (!mounted.current || batch.length === 0) return
    const documents = results.map((result, index) => {
      const document = batch[index].document
      return result.status === 'fulfilled'
        ? validateDocument({ ...document, text: result.value })
        : { ...document, error: `Unable to read ${document.name}: ${errorMessage(result.reason)}` }
    })
    const latest = current.current
    change({ documents: [...latest.documents, ...documents], activeId: documents[0].id })
  }, [change])

  const updateText = useCallback((id: string, text: string) => {
    const latest = current.current
    if (!latest.documents.some((document) => document.id === id)) return
    change({
      ...latest,
      documents: latest.documents.map((document) => document.id === id ? { ...document, text, dirty: true } : document),
    })
    scheduleValidation(id)
  }, [change, scheduleValidation])

  const applyProposal = useCallback((id: string, expected: string, next: string) => {
    const document = current.current.documents.find((item) => item.id === id)
    if (!document || document.text !== expected) return false
    try {
      parse(next)
    } catch {
      return false
    }
    updateText(id, next)
    return true
  }, [updateText])

  const selectView = useCallback((id: string, selectedKey: string) => {
    const latest = current.current
    const document = latest.documents.find((item) => item.id === id)
    if (!document || document.selectedKey === selectedKey) return
    change({
      ...latest,
      documents: latest.documents.map((item) => item.id === id ? { ...item, selectedKey } : item),
    })
  }, [change])

  const markSaved = useCallback((id: string) => {
    const latest = current.current
    if (!latest.documents.some((document) => document.id === id && document.dirty)) return
    change({
      ...latest,
      documents: latest.documents.map((document) => document.id === id ? { ...document, dirty: false } : document),
    })
  }, [change])

  const closeDocument = useCallback((id: string): boolean => {
    const latest = current.current
    const index = latest.documents.findIndex((document) => document.id === id)
    if (index === -1) return false
    const document = latest.documents[index]
    if (document.dirty && !window.confirm(`¿Cerrar "${document.name}" sin descargar los cambios?`)) return false
    const timer = validationTimers.current.get(id)
    if (timer !== undefined) clearTimeout(timer)
    validationTimers.current.delete(id)
    pendingValidation.current.delete(id)
    const documents = latest.documents.filter((item) => item.id !== id)
    const activeId = latest.activeId === id
      ? (documents[index] ?? documents[index - 1])?.id ?? null
      : latest.activeId
    change({ documents, activeId })
    return true
  }, [change])

  return {
    documents: state.documents,
    activeId: state.activeId,
    active: state.documents.find((document) => document.id === state.activeId) ?? null,
    setActiveId,
    addFiles,
    updateText,
    selectView,
    closeDocument,
    markSaved,
    applyProposal,
    storageError,
  }
}

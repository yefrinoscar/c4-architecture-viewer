import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { validateDsl } from './DslEditor.tsx'
import { AiMarkdown } from './AiMarkdown.tsx'
import { changeLines, changeSummary, computeDiff, diffStats, openDslFence, removedLines, streamStats, suggestedFileName } from './diff.ts'
import { parseWorkspace } from '../dsl/parse.ts'
import './AiChat.css'

export interface AiChatProps {
  document: { id: string; name: string; text: string } | null
  onApply: (id: string, expectedText: string, nextText: string) => boolean
  onClose: () => void
  hidden?: boolean
}

type Model = { id: string; protocol: string }
type ChatGptAuth = { enabled: boolean; signedIn: boolean; email?: string | null; name?: string | null }
type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'conflict'
type Proposal = { next: string; status: ProposalStatus }
type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  state: 'streaming' | 'complete' | 'failed' | 'stopped'
  snapshot?: string
  model?: string
  notice?: string
  proposal?: Proposal
}
type Conversation = { sessionId: string; messages: Message[]; draft: string; error?: string }
type Request = { controller: AbortController; documentId: string; sessionId: string; messageId: string }

const BYTE_LIMIT = 1024 * 1024
const PROMPT_LIMIT = 10000
const STATUS_LABELS: Record<ProposalStatus, string> = {
  pending: 'Pendiente de aprobación',
  applied: 'Aplicada',
  rejected: 'Rechazada',
  conflict: 'Conflicto: el documento cambió o se cerró. No se aplicó nada.',
}

class ChatError extends Error {}

function newConversation(): Conversation {
  return { sessionId: crypto.randomUUID(), messages: [], draft: '' }
}

function serverMessage(value: unknown, fallback: string, key = ''): string {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const safe = key ? value.split(key).join('[clave oculta]') : value
  return safe.slice(0, 400)
}

async function* readChunks(response: Response, signal: AbortSignal) {
  if (!response.body) throw new ChatError('El servidor devolvió una respuesta vacía. Vuelve a intentarlo.')
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  let bytes = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      bytes += value.byteLength
      if (bytes > BYTE_LIMIT) throw new ChatError('La respuesta superó 1 MB. Solicita una respuesta más pequeña.')
      yield value
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  for await (const chunk of readChunks(response, signal)) text += decoder.decode(chunk, { stream: true })
  return JSON.parse(text + decoder.decode())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function httpError(response: Response, signal: AbortSignal, key = ''): Promise<ChatError> {
  const fallback = response.status === 401
    ? 'La clave no fue aceptada. Revisa tu clave de OpenCode.'
    : response.status === 429
      ? 'Se alcanzó el límite de uso. Espera antes de reintentar o revisa tu plan.'
      : 'No se pudo completar la solicitud. Vuelve a intentarlo.'
  try {
    const body = await readJson(response, signal)
    return new ChatError(`HTTP ${response.status}: ${serverMessage(isRecord(body) ? body.error : null, fallback, key)}`)
  } catch {
    return new ChatError(`HTTP ${response.status}: ${fallback}`)
  }
}

function proposalFrom(content: string): { proposal?: Proposal; notice?: string } {
  let fence: { marker: string; start: number; dsl: boolean } | undefined
  let offset = 0
  let count = 0
  let next: string | undefined
  for (const line of content.split('\n')) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})([^\r]*)\r?$/)
    if (match) {
      const [, marker, info] = match
      if (!fence) {
        const dsl = marker === '```' && info.trim() === 'dsl'
        if (dsl) count += 1
        fence = { marker, start: offset + line.length + 1, dsl }
      } else if (marker[0] === fence.marker[0] && marker.length >= fence.marker.length && !info.trim()) {
        if (fence.dsl) next = content.slice(fence.start, offset)
        fence = undefined
      }
    }
    offset += line.length + 1
  }
  if (!count) return {}
  if (count !== 1 || fence || next === undefined) {
    return { notice: 'Sin propuesta aplicable: se necesita exactamente un bloque ```dsl completo.' }
  }
  try {
    if (validateDsl(next)) throw new ChatError('DSL inválido')
    parseWorkspace(next)
    return { proposal: { next, status: 'pending' } }
  } catch {
    return { notice: 'El DSL propuesto no pasó la validación local. Pide una versión corregida; no se puede aplicar.' }
  }
}

function sendingHistory(messages: Message[]) {
  const history = messages.filter((message) => message.state === 'complete').map((message) => ({
    role: message.role,
    content: message.role === 'assistant'
      ? message.content.replace(/(^|\n) {0,3}```dsl[^\S\r\n]*\r?\n[\s\S]*?\n {0,3}```[^\S\r\n]*(?=\r?\n|$)/g, '$1[DSL anterior omitido; usa el contexto actual]')
        + (message.proposal ? `\n[Propuesta: ${STATUS_LABELS[message.proposal.status]}]` : '')
      : message.content,
  })).slice(-20)
  let chars = history.reduce((sum, message) => sum + message.content.length, 0)
  while (chars >= 100000 && history.length > 1) chars -= history.shift()!.content.length
  return history
}

function LineDiff({ before, after }: { before: string; after: string }) {
  const hunk = computeDiff(before, after)
  return (
    <div className="ai-diff">
      <p className="ai-caption">Rango distinto desde línea {hunk.start + 1} · −{hunk.before.length} / +{hunk.after.length}</p>
      <pre tabIndex={0} aria-label="Diferencias de líneas">
        {hunk.start > 0 && <span className="ai-diff-context">{`${hunk.start} líneas iniciales sin cambios\n`}</span>}
        <span className="ai-diff-minus">{hunk.before.map((line) => `− ${line}\n`).join('')}</span>
        <span className="ai-diff-plus">{hunk.after.map((line) => `+ ${line}\n`).join('')}</span>
        {hunk.beforeTotal - hunk.start - hunk.before.length > 0 && <span className="ai-diff-context">{`${hunk.beforeTotal - hunk.start - hunk.before.length} líneas finales sin cambios`}</span>}
      </pre>
    </div>
  )
}

function downloadProposal(name: string | undefined, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = suggestedFileName(name)
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function AiChat({ document, onApply, onClose, hidden }: AiChatProps) {
  const uid = useId()
  const [apiKey, setApiKey] = useState('')
  const [chatGpt, setChatGpt] = useState<ChatGptAuth>({ enabled: false, signedIn: false })
  const [consent, setConsent] = useState(false)
  const [models, setModels] = useState<Model[]>([])
  const [model, setModel] = useState('')
  const [modelsLoading, setModelsLoading] = useState(true)
  const [modelsError, setModelsError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [conversations, setConversations] = useState(new Map<string, Conversation>())
  const conversationsRef = useRef(conversations)
  const [busy, setBusy] = useState<Request | null>(null)
  const requestRef = useRef<Request | null>(null)
  const mounted = useRef(false)
  const latest = useRef({ document, onApply })
  const configButton = useRef<HTMLButtonElement>(null)
  const keyInput = useRef<HTMLInputElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const stick = useRef(true)

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    configButton.current?.focus()
  }, [])

  const [wasHidden, setWasHidden] = useState(hidden)
  if (wasHidden !== hidden) {
    setWasHidden(hidden)
    if (hidden) setSettingsOpen(false)
  }

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/auth/status', { signal: controller.signal, cache: 'no-store' }).then(async (response) => {
      if (!response.ok) return
      const data = await response.json()
      if (isRecord(data) && typeof data.enabled === 'boolean' && typeof data.signedIn === 'boolean') setChatGpt(data as ChatGptAuth)
    }).catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (settingsOpen) keyInput.current?.focus()
  }, [settingsOpen])

  useLayoutEffect(() => {
    latest.current = { document, onApply }
  }, [document, onApply])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      requestRef.current?.controller.abort()
      requestRef.current = null
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch('/api/ai/models', { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw await httpError(response, controller.signal)
        const data = await readJson(response, controller.signal)
        if (!isRecord(data) || !Array.isArray(data.models) || !data.models.every((item: unknown) =>
          isRecord(item) && typeof item.id === 'string' && !!item.id && typeof item.protocol === 'string')) {
          throw new ChatError('La lista de modelos no es válida. Reintenta la carga.')
        }
        const available = [...new Map((data.models as Model[]).map((item) => [item.id, item])).values()]
        if (!available.length) throw new ChatError('No hay modelos disponibles. Actualiza la lista más tarde.')
        if (controller.signal.aborted) return
        setModels(available)
        setModel((current) => available.some((item) => item.id === current) ? current : available[0].id)
      } catch (error) {
        if (controller.signal.aborted) return
        setModels([])
        setModel('')
        setModelsError(error instanceof ChatError ? error.message : 'No se pudieron cargar los modelos. Comprueba la conexión y reintenta.')
      } finally {
        if (!controller.signal.aborted) setModelsLoading(false)
      }
    })()
    return () => controller.abort()
  }, [refresh, chatGpt.signedIn])

  const changeConversation = useCallback((id: string, update: (current: Conversation) => Conversation) => {
    if (!mounted.current) return
    const next = new Map(conversationsRef.current)
    next.set(id, update(next.get(id) ?? newConversation()))
    conversationsRef.current = next
    setConversations(next)
  }, [])

  const updateResponse = (request: Request, update: (message: Message) => Message) => {
    if (requestRef.current !== request || !mounted.current) return
    changeConversation(request.documentId, (current) => current.sessionId !== request.sessionId ? current : {
      ...current,
      messages: current.messages.map((message) => message.id === request.messageId ? update(message) : message),
    })
  }

  const stop = () => {
    const request = requestRef.current
    if (!request) return
    request.controller.abort()
    updateResponse(request, (message) => ({ ...message, state: 'stopped', proposal: undefined, notice: 'Respuesta detenida. No se puede aplicar.' }))
    requestRef.current = null
    setBusy(null)
  }

  const reset = () => {
    const active = latest.current.document
    if (!active) return
    if (!window.confirm(requestRef.current
      ? '¿Detener la solicitud en curso y borrar la conversación del documento activo?'
      : '¿Borrar la conversación del documento activo e iniciar una nueva?')) return
    stop()
    changeConversation(active.id, () => newConversation())
    composer.current?.focus()
  }

  const send = async () => {
    const active = latest.current.document
    if (!active || requestRef.current || (!apiKey.trim() && !chatGpt.signedIn) || !consent || modelsLoading || !models.some((item) => item.id === model)) return
    const conversation = conversationsRef.current.get(active.id) ?? newConversation()
    const prompt = conversation.draft.trim()
    if (!prompt || conversation.draft.length > PROMPT_LIMIT) return
    if (active.text.length > 500000) {
      changeConversation(active.id, (current) => ({ ...current, error: 'El DSL supera los 500000 caracteres admitidos por el servidor.' }))
      return
    }
    const key = apiKey.trim()
    if (key && prompt.includes(key)) {
      changeConversation(active.id, (current) => ({ ...current, error: 'No incluyas tu clave de API en el mensaje. Usa únicamente el campo de clave.' }))
      return
    }
    const snapshot = active.text
    const user: Message = { id: crypto.randomUUID(), role: 'user', content: prompt, state: 'complete' }
    const assistant: Message = { id: crypto.randomUUID(), role: 'assistant', content: '', state: 'streaming', snapshot, model }
    const body = JSON.stringify({ apiKey: chatGpt.signedIn ? undefined : key, chatGpt: chatGpt.signedIn, model, sessionId: conversation.sessionId, messages: sendingHistory([...conversation.messages, user]), dsl: snapshot })
    if (new TextEncoder().encode(body).byteLength > BYTE_LIMIT) {
      changeConversation(active.id, (current) => ({ ...current, error: 'El contexto y el historial superan 1 MB. Reduce el documento o inicia una conversación nueva.' }))
      return
    }
    const request: Request = { controller: new AbortController(), documentId: active.id, sessionId: conversation.sessionId, messageId: assistant.id }
    requestRef.current = request
    setBusy(request)
    changeConversation(active.id, () => ({ ...conversation, draft: '', error: undefined, messages: [...conversation.messages, user, assistant] }))
    let text = ''
    let finished = false
    let frame: number | undefined
    const paint = () => {
      frame = undefined
      updateResponse(request, (message) => ({ ...message, content: key ? text.split(key).join('[clave oculta]') : text }))
    }
    const schedule = () => {
      if (frame !== undefined) return
      frame = window.setTimeout(paint, 67)
    }
    const cancel = () => {
      if (frame === undefined) return
      window.clearTimeout(frame)
      frame = undefined
    }
    try {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body,
        signal: request.controller.signal,
        cache: 'no-store',
      })
      if (!response.ok) throw await httpError(response, request.controller.signal, key)
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let buffer = ''
      const line = (raw: string) => {
        if (!raw.trim()) return
        if (finished) throw new ChatError('El servidor envió datos después del cierre de la respuesta. No se puede aplicar.')
        const event: unknown = JSON.parse(raw)
        if (!isRecord(event)) throw new ChatError('La respuesta del servidor no es válida. Reintenta la solicitud.')
        if (event.type === 'delta' && typeof event.text === 'string') {
          text += event.text
        } else if (event.type === 'done') {
          finished = true
        } else if (event.type === 'error') {
          throw new ChatError(serverMessage(event.message ?? event.error, 'No se pudo completar la respuesta. Reintenta la solicitud.', key))
        } else {
          throw new ChatError('Se recibió un evento desconocido. No se puede aplicar la respuesta.')
        }
      }
      for await (const chunk of readChunks(response, request.controller.signal)) {
        buffer += decoder.decode(chunk, { stream: true })
        let end = buffer.indexOf('\n')
        while (end !== -1) {
          line(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          end = buffer.indexOf('\n')
        }
        schedule()
      }
      cancel()
      buffer += decoder.decode()
      if (buffer.trim()) line(buffer)
      if (!finished) throw new ChatError('La conexión terminó antes de completar la respuesta. No se puede aplicar; vuelve a intentarlo.')
      request.controller.signal.throwIfAborted()
      const safeText = key ? text.split(key).join('[clave oculta]') : text
      const proposal = key && text.includes(key) ? { notice: 'Se ocultó una clave en la respuesta. No se permite aplicar esta propuesta.' } : proposalFrom(safeText)
      updateResponse(request, (message) => ({ ...message, content: safeText, state: 'complete', ...proposal }))
    } catch (error) {
      cancel()
      updateResponse(request, (message) => ({
        ...message,
        state: request.controller.signal.aborted ? 'stopped' : 'failed',
        proposal: undefined,
        notice: request.controller.signal.aborted ? 'Respuesta detenida. No se puede aplicar.'
          : error instanceof ChatError ? error.message : 'No se pudo completar la respuesta. Comprueba la conexión y vuelve a intentarlo.',
      }))
    } finally {
      if (requestRef.current === request) {
        requestRef.current = null
        if (mounted.current) setBusy(null)
      }
    }
  }

  const decide = (documentId: string, sessionId: string, messageId: string, accept: boolean) => {
    const conversation = conversationsRef.current.get(documentId)
    const message = conversation?.messages.find((item) => item.id === messageId)
    if (conversation?.sessionId !== sessionId || message?.state !== 'complete' || !message.proposal || message.proposal.status !== 'pending' || message.snapshot === undefined) return
    let status: ProposalStatus = 'rejected'
    if (accept) {
      const current = latest.current
      status = 'conflict'
      if (current.document?.id === documentId && current.document.text === message.snapshot) {
        try {
          if (current.onApply(documentId, message.snapshot, message.proposal.next)) status = 'applied'
        } catch {
          status = 'conflict'
        }
      }
    }
    changeConversation(documentId, (current) => ({ ...current, messages: current.messages.map((item) =>
      item.id === messageId && item.proposal ? { ...item, proposal: { ...item.proposal, status } } : item) }))
  }

  const conversation = document ? conversations.get(document.id) : undefined
  const draft = conversation?.draft ?? ''
  const canSend = !!document && !!draft.trim() && draft.length <= PROMPT_LIMIT && (!!apiKey.trim() || chatGpt.signedIn) && !!model && consent && !busy && !modelsLoading

  const follow = conversation?.messages
  useEffect(() => {
    if (!follow?.length) return
    const node = scroll.current
    if (node && stick.current) node.scrollTop = node.scrollHeight
  }, [follow])

  return (
    <aside hidden={hidden} className="ai-chat" aria-labelledby={`${uid}-title`} onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape' && settingsOpen) {
        event.preventDefault()
        closeSettings()
      }
    }}>
      <header className="ai-header">
        <div><h2 id={`${uid}-title`}>Asistente DSL</h2><span className="ai-caption">OpenCode · revisión antes de aplicar</span></div>
        <div className="ai-header-actions">
          <button type="button" ref={configButton} className="ai-icon-button" onClick={() => setSettingsOpen(true)} aria-label="Configuración" title="Configuración" aria-haspopup="dialog" aria-expanded={settingsOpen}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 11 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9 2 2 0 1 1 0 4Z" /></svg>
          </button>
          <button type="button" className="ai-icon-button" onClick={onClose} aria-label="Cerrar asistente" title="Cerrar asistente">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </div>
      </header>
      <div className="ai-context"><span className="ai-caption">Contexto</span><strong title={document?.name}>{document?.name ?? 'Sin documento activo'}</strong></div>
      {!apiKey && !chatGpt.signedIn && <div className="ai-setup-hint"><span role="status">Inicia sesión con ChatGPT o configura una clave de API para conversar.</span><button type="button" className="ai-text-button" onClick={() => setSettingsOpen(true)}>Abrir configuración</button></div>}
      <div className="ai-conversation-tools">
        <button type="button" className="ai-text-button" disabled={!document} onClick={reset}>Nueva conversación</button>
        <button type="button" className="ai-text-button" onClick={() => { const node = scroll.current; if (node) node.scrollTop = node.scrollHeight }}>Ir al último</button>
      </div>
      {busy && <div className="ai-request-status"><span role="status">{busy.documentId === document?.id ? 'Recibiendo respuesta…' : 'Solicitud activa en otro documento…'}</span><button type="button" className="ai-button" onClick={stop}>Detener</button></div>}
      <div key={document?.id ?? 'empty'} className="ai-conversation" ref={scroll} tabIndex={0} role="region" aria-label="Conversación del documento activo" onScroll={(event) => {
        const node = event.currentTarget
        stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
      }}>
        {!conversation?.messages.length && <div className="ai-empty"><span className="ai-eyebrow">Tu documento, con contexto</span><h3>{document ? '¿Qué quieres revisar?' : 'Abre un documento DSL'}</h3><p>Consulta la arquitectura o pide un cambio concreto. Las propuestas nunca se aplican automáticamente.</p><button type="button" className="ai-button" disabled={!document} onClick={() => composer.current?.focus()}>Escribir un mensaje</button></div>}
        {conversation?.messages.map((message) => {
          const streaming = message.state === 'streaming'
          const snapshot = message.snapshot
          const proposal = message.proposal
          const partial = streaming && snapshot !== undefined ? openDslFence(message.content) : undefined
          const live = partial !== undefined ? streamStats(snapshot ?? '', partial) : undefined
          const stats = proposal && snapshot !== undefined ? diffStats(snapshot, proposal.next) : undefined
          const changed = proposal && snapshot !== undefined
            ? [...changeLines(snapshot, proposal.next), ...removedLines(snapshot, proposal.next)].sort((left, right) => left.line - right.line)
            : []
          const fileName = suggestedFileName(document?.name)
          return (
            <article className={`ai-message ai-message-${message.role}`} key={message.id}>
              <div className="ai-message-heading"><strong>{message.role === 'user' ? 'Tú' : 'Asistente'}</strong>{message.model && <span title={message.model}>{message.model}</span>}</div>
              {message.role === 'user'
                ? <div className="ai-message-text">{message.content}</div>
                : message.content
                  ? <AiMarkdown text={message.content} streaming={streaming} dslNote={message.proposal ? 'Propuesta DSL · revisa la tarjeta de abajo' : undefined} />
                  : <div className="ai-message-text">{streaming ? 'Esperando respuesta…' : 'Sin respuesta de texto.'}</div>}
              {streaming && (
                <p className="ai-stream-status" role="status">
                  {live && live.written > 1
                    ? `Generando propuesta DSL… ${live.written} líneas escritas${live.changed ? ` · ${live.changed} ${live.changed === 1 ? 'modificada' : 'modificadas'}` : ''}${live.added ? ` · ${live.added} ${live.added === 1 ? 'nueva' : 'nuevas'}` : ''}`
                    : `Escribiendo… ${message.content.length.toLocaleString()} caracteres`}
                </p>
              )}
              {message.notice && <p className={message.state === 'failed' ? 'ai-error' : 'ai-notice'} role="status">{message.notice}</p>}
              {proposal && snapshot !== undefined && stats && (
                <div className="ai-approval">
                  <div className="ai-approval-summary">
                    <strong>Qué cambia</strong>
                    <span className="ai-caption">{changeSummary(stats)}</span>
                  </div>
                  {changed.length > 0 && (
                    <ul className="ai-change-list">
                      {changed.map((item) => (
                        <li key={`${item.line}-${item.from}`} className={item.to ? undefined : 'ai-change-removed'}>
                          <span className="ai-caption">L{item.line}</span>
                          <code className={item.to ? 'ai-diff-minus' : 'ai-diff-context'}>{item.from || '—'}</code>
                          <span aria-hidden="true">→</span>
                          <code className={item.to ? 'ai-diff-plus' : 'ai-diff-context'}>{item.to || '—'}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                  <details className="ai-review">
                    <summary>Revisar propuesta DSL <span className="ai-caption">Fuente completa y diferencias</span></summary>
                    <div className="ai-review-body">
                      <p className="ai-caption">Validación estructural local correcta; no sustituye la validación de Structurizr.</p>
                      <LineDiff before={snapshot} after={proposal.next} />
                      <details><summary>Antes · fuente completa enviada</summary><pre tabIndex={0} aria-label="DSL anterior completo">{snapshot}</pre></details>
                      <details><summary>Después · fuente completa propuesta</summary><pre tabIndex={0} aria-label="DSL propuesto completo">{proposal.next}</pre></details>
                    </div>
                  </details>
                  <p className="ai-notice" role="status">{STATUS_LABELS[proposal.status]}</p>
                  {proposal.status === 'pending' && <>
                    {document?.text !== snapshot && <p className="ai-error" role="status">El documento cambió desde el envío. Solicita una propuesta nueva; esta ya no se puede aplicar.</p>}
                    <div className="ai-approval-actions">
                      <button type="button" className="ai-button ai-button-primary" disabled={!document || document.text !== snapshot || !!busy} onClick={() => { if (document) decide(document.id, conversation.sessionId, message.id, true) }}>Aceptar y aplicar</button>
                      <button type="button" className="ai-button" onClick={() => { if (document) decide(document.id, conversation.sessionId, message.id, false) }}>Rechazar</button>
                    </div>
                  </>}
                  <div className="ai-approval-extra">
                    <button type="button" className="ai-button" onClick={() => downloadProposal(document?.name, proposal.next)}>Guardar .dsl</button>
                    <span className="ai-caption">{fileName}</span>
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>
      <form className="ai-composer" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void send() }}>
        <label className="ai-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>Acepto enviar el DSL completo del documento activo y el historial a OpenCode y al modelo seleccionado en cada solicitud. Consume mi plan.</span></label>
        {conversation?.error && <p className="ai-error" role="alert">{conversation.error}</p>}
        <label htmlFor={`${uid}-prompt`} className="ai-caption">Mensaje</label>
        <div className="ai-composer-field">
          <textarea key={document?.id ?? 'none'} id={`${uid}-prompt`} ref={composer} value={draft} rows={3} maxLength={PROMPT_LIMIT} autoComplete="off" placeholder={document ? 'Pregunta o describe el cambio…' : 'Selecciona un documento para comenzar'} disabled={!document || !!busy} aria-describedby={`${uid}-composer-help`} onChange={(event) => { if (document) changeConversation(document.id, (current) => ({ ...current, draft: event.target.value, error: undefined })) }} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.nativeEvent.keyCode !== 229) {
              event.preventDefault()
              if (!event.repeat) void send()
            }
          }} />
          <div className="ai-composer-footer"><span className="ai-caption">{draft.length.toLocaleString()} / 10.000</span><button type="submit" className="ai-button ai-button-primary" disabled={!canSend}>Enviar <span aria-hidden="true">↑</span></button></div>
        </div>
        <p id={`${uid}-composer-help`} className="ai-caption">Enter para enviar · Shift + Enter para nueva línea</p>
      </form>
      {settingsOpen && (
        <div className="ai-settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSettings() }}>
          <section className="ai-settings-modal" role="dialog" aria-modal="true" aria-labelledby={`${uid}-settings-title`}>
            <header className="ai-settings-head">
              <h3 id={`${uid}-settings-title`}>Configuración</h3>
              <button type="button" className="ai-icon-button" onClick={closeSettings} aria-label="Cerrar configuración" title="Cerrar configuración">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </header>
             <div className="ai-settings-body">
               {chatGpt.enabled && <div className="ai-chatgpt-auth">
                 <strong>{chatGpt.signedIn ? `Conectado con ChatGPT${chatGpt.email ? ` · ${chatGpt.email}` : ''}` : 'Usar mi plan de ChatGPT'}</strong>
                 {chatGpt.signedIn
                   ? <button type="button" className="ai-button" onClick={() => { stop(); void fetch('/api/auth/logout', { method: 'POST' }).then(() => { setChatGpt({ enabled: true, signedIn: false }); setModels([]); setModel('') }) }}>Cerrar sesión</button>
                   : <a className="ai-button ai-button-primary" href="/auth/chatgpt">Continuar con ChatGPT</a>}
                 <p className="ai-caption">El token se conserva únicamente en el servidor local y se usa para solicitudes Responses API elegibles.</p>
               </div>}
               <label htmlFor={`${uid}-key`}>Clave de API de OpenCode</label>
              <div className="ai-control-row">
                <input id={`${uid}-key`} ref={keyInput} type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" value={apiKey} maxLength={999} onChange={(event) => setApiKey(event.target.value)} aria-describedby={`${uid}-privacy`} />
                <button type="button" className="ai-button" disabled={!apiKey} onClick={() => { stop(); setApiKey('') }}>Borrar clave</button>
              </div>
              <p id={`${uid}-privacy`} className="ai-caption">La clave y el chat solo permanecen en memoria hasta recargar. Los documentos DSL mantienen su guardado local habitual. Borrar la clave detiene la solicitud activa.</p>
              <div className="ai-models">
                <label htmlFor={`${uid}-model`} className="ai-caption">Modelo</label>
                <div className="ai-control-row">
                  <select id={`${uid}-model`} value={model} disabled={!!busy || modelsLoading || !models.length} onChange={(event) => setModel(event.target.value)}>
                    {!models.length && <option value="">{modelsLoading ? 'Cargando modelos…' : 'Sin modelos'}</option>}
                    {models.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.protocol}</option>)}
                  </select>
                  <button type="button" className="ai-button" disabled={!!busy || modelsLoading} onClick={() => { setModelsLoading(true); setModelsError(''); setRefresh((value) => value + 1) }}>{modelsError ? 'Reintentar' : 'Actualizar'}</button>
                </div>
                {modelsError && <p className="ai-error" role="alert">{modelsError}</p>}
              </div>
            </div>
          </section>
        </div>
      )}
    </aside>
  )
}

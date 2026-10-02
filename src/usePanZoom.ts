import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

type Size = { width: number; height: number }
type Point = { x: number; y: number }
type Transform = { scale: number; tx: number; ty: number }

const MIN_SCALE = 0.08
const MAX_SCALE = 8
const VIEWPORT_PADDING = 40
const BOTTOM_INSET = 72
// Una muesca de ratón equivale aproximadamente a un 12 % de zoom. Los deltas
// pequeños de un trackpad conservan su precisión y se agrupan por frame.
const WHEEL_SENSITIVITY = 0.0015
const PINCH_SENSITIVITY = 0.01
const MAX_WHEEL_DELTA = 120
export const ZOOM_STEP = 1.2
// El lienzo puede moverse libremente sin llegar a perderse por completo.
const KEEP_VISIBLE = 96

const clampScale = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))

function clampOffset(value: number, content: number, viewport: number): number {
  if (!viewport) return value
  const keep = Math.min(KEEP_VISIBLE, Math.max(24, content * 0.3))
  return Math.min(viewport - keep, Math.max(keep - content, value))
}

function zoomAround(transform: Transform, scale: number, point: Point): Transform {
  const ratio = scale / transform.scale
  return {
    scale,
    tx: point.x - ratio * (point.x - transform.tx),
    ty: point.y - ratio * (point.y - transform.ty),
  }
}

export function usePanZoom() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  // El transform se pinta directamente para que React no tenga que renderizar
  // toda la aplicación durante cada frame de un gesto.
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [transform, setTransform] = useState<Transform>({ scale: 1, tx: 0, ty: 0 })
  const [natural, setNatural] = useState<Size | null>(null)
  const [container, setContainer] = useState<Size>({ width: 0, height: 0 })
  const manual = useRef(false)
  const transformRef = useRef(transform)
  const animationFrame = useRef<number | null>(null)
  const gestureFrame = useRef<number | null>(null)
  const wheelFrame = useRef<number | null>(null)
  const wheelCommit = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingTransform = useRef<Transform | null>(null)
  const wheel = useRef<{
    mode: 'pan' | 'zoom'
    delta: number
    dx: number
    dy: number
    point: Point
    sensitivity: number
  } | null>(null)
  const pointers = useRef(new Map<number, Point>())
  const pan = useRef<{ pointerId: number; point: Point; transform: Transform } | null>(null)
  const pinch = useRef<{
    distance: number
    center: Point
    transform: Transform
  } | null>(null)

  const stopAnimation = useCallback(() => {
    if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current)
    animationFrame.current = null
  }, [])

  const clampTransform = useCallback((next: Transform): Transform => {
    const width = (natural?.width ?? 0) * next.scale
    const height = (natural?.height ?? 0) * next.scale
    if (!natural?.width || !natural?.height || !container.width || !container.height) return next
    return {
      scale: next.scale,
      tx: clampOffset(next.tx, width, container.width),
      ty: clampOffset(next.ty, height, container.height),
    }
  }, [natural, container])

  const paint = useCallback((next: Transform) => {
    transformRef.current = next
    const host = hostRef.current
    if (host) host.style.transform = `translate3d(${next.tx}px, ${next.ty}px, 0) scale(${next.scale})`
  }, [])

  const applyTransform = useCallback((next: Transform) => {
    const fitted = clampTransform(next)
    paint(fitted)
    setTransform(fitted)
  }, [clampTransform, paint])

  const flushGesture = useCallback(() => {
    gestureFrame.current = null
    const next = pendingTransform.current
    pendingTransform.current = null
    if (next) paint(next)
  }, [paint])

  const schedulePaint = useCallback((next: Transform) => {
    pendingTransform.current = clampTransform(next)
    if (gestureFrame.current === null) gestureFrame.current = requestAnimationFrame(flushGesture)
  }, [clampTransform, flushGesture])

  const commitGesture = useCallback(() => {
    if (gestureFrame.current !== null) {
      cancelAnimationFrame(gestureFrame.current)
      gestureFrame.current = null
    }
    if (pendingTransform.current) paint(pendingTransform.current)
    pendingTransform.current = null
    setTransform(transformRef.current)
  }, [paint])

  useEffect(() => () => {
    stopAnimation()
    if (gestureFrame.current !== null) cancelAnimationFrame(gestureFrame.current)
    if (wheelFrame.current !== null) cancelAnimationFrame(wheelFrame.current)
    if (wheelCommit.current !== null) clearTimeout(wheelCommit.current)
  }, [stopAnimation])

  useLayoutEffect(() => {
    paint(transformRef.current)
  }, [natural, paint])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect
      setContainer({ width: rect.width, height: rect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const fit = useCallback(() => {
    stopAnimation()
    manual.current = false
    if (!natural || !container.width || !container.height) return
    const safeWidth = Math.max(1, container.width - VIEWPORT_PADDING * 2)
    const safeHeight = Math.max(1, container.height - VIEWPORT_PADDING * 2 - BOTTOM_INSET)
    const scale = clampScale(Math.min(safeWidth / natural.width, safeHeight / natural.height))
    applyTransform({
      scale,
      tx: (container.width - natural.width * scale) / 2,
      ty: VIEWPORT_PADDING + (safeHeight - natural.height * scale) / 2,
    })
  }, [natural, container, applyTransform, stopAnimation])

  useEffect(() => {
    if (!manual.current) fit()
  }, [fit])

  useEffect(() => {
    const current = transformRef.current
    const fitted = clampTransform(current)
    if (fitted.tx !== current.tx || fitted.ty !== current.ty) applyTransform(current)
  }, [container, clampTransform, applyTransform])

  const zoomAnimated = useCallback((factor: number, point: Point) => {
    if (pointers.current.size) return
    stopAnimation()
    manual.current = true
    const start = transformRef.current
    const target = clampTransform(zoomAround(start, clampScale(start.scale * factor), point))
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      applyTransform(target)
      return
    }

    const duration = 140
    const startedAt = performance.now()
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      paint({
        scale: start.scale + (target.scale - start.scale) * eased,
        tx: start.tx + (target.tx - start.tx) * eased,
        ty: start.ty + (target.ty - start.ty) * eased,
      })
      if (progress < 1) animationFrame.current = requestAnimationFrame(step)
      else {
        animationFrame.current = null
        setTransform(target)
      }
    }
    animationFrame.current = requestAnimationFrame(step)
  }, [applyTransform, clampTransform, paint, stopAnimation])

  const zoomBy = useCallback((factor: number) => {
    zoomAnimated(factor, { x: container.width / 2, y: container.height / 2 })
  }, [container, zoomAnimated])

  const actualSize = useCallback(() => {
    stopAnimation()
    manual.current = true
    if (!natural || !container.width || !container.height) return
    const safeWidth = Math.max(1, container.width - VIEWPORT_PADDING * 2)
    const safeHeight = Math.max(1, container.height - BOTTOM_INSET)
    applyTransform({
      scale: 1,
      tx: natural.width <= safeWidth ? (container.width - natural.width) / 2 : VIEWPORT_PADDING,
      ty: natural.height <= safeHeight ? (safeHeight - natural.height) / 2 : VIEWPORT_PADDING,
    })
  }, [container, natural, applyTransform, stopAnimation])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      stopAnimation()
      manual.current = true
      const rect = el.getBoundingClientRect()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1
      const dx = event.deltaX * unit
      const dy = event.deltaY * unit
      // Chrome marca el gesto de pellizco del trackpad con ctrlKey. Una rueda
      // física suele emitir saltos grandes y verticales. El resto es scroll de
      // dos dedos y debe desplazar el canvas, como Miro/Figma.
      const mouseWheel = event.deltaMode !== 0 || (Math.abs(dx) < 1 && Math.abs(dy) >= 40)
      const mode = event.ctrlKey || mouseWheel ? 'zoom' : 'pan'
      const delta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, dy))
      const current = wheel.current
      wheel.current = {
        mode,
        delta: (current?.delta ?? 0) + delta,
        dx: (current?.mode === mode ? current.dx : 0) + (event.shiftKey && dx === 0 ? dy : dx),
        dy: (current?.mode === mode ? current.dy : 0) + (event.shiftKey && dx === 0 ? 0 : dy),
        point: { x: event.clientX - rect.left, y: event.clientY - rect.top },
        sensitivity: event.ctrlKey ? PINCH_SENSITIVITY : WHEEL_SENSITIVITY,
      }
      if (wheelFrame.current !== null) return
      wheelFrame.current = requestAnimationFrame(() => {
        wheelFrame.current = null
        const input = wheel.current
        wheel.current = null
        if (!input) return
        const start = transformRef.current
        const next = input.mode === 'zoom'
          ? clampTransform(zoomAround(
              start,
              clampScale(start.scale * Math.exp(-Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, input.delta)) * input.sensitivity)),
              input.point,
            ))
          : clampTransform({
              ...start,
              tx: start.tx - Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, input.dx)),
              ty: start.ty - Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, input.dy)),
            })
        paint(next)
        // El SVG se mueve directamente en el compositor. React sólo actualiza
        // el porcentaje cuando termina la ráfaga, no 60 veces por segundo.
        if (wheelCommit.current !== null) clearTimeout(wheelCommit.current)
        wheelCommit.current = setTimeout(() => {
          wheelCommit.current = null
          setTransform(transformRef.current)
        }, 90)
      })
    }
    const onDragStart = (event: DragEvent) => event.preventDefault()
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('dragstart', onDragStart)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('dragstart', onDragStart)
    }
  }, [clampTransform, paint, stopAnimation])

  const localPoint = useCallback((event: ReactPointerEvent<HTMLDivElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }, [])

  const beginPinch = useCallback(() => {
    const [a, b] = Array.from(pointers.current.values())
    if (!a || !b) return
    pinch.current = {
      distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      transform: transformRef.current,
    }
    pan.current = null
  }, [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('button, label, input, a, select, textarea, [role="button"]')) return
    event.preventDefault()
    stopAnimation()
    manual.current = true
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* Algunos navegadores no permiten captura durante determinados gestos. */
    }
    const point = localPoint(event)
    pointers.current.set(event.pointerId, point)
    if (pointers.current.size === 1) {
      pan.current = { pointerId: event.pointerId, point, transform: transformRef.current }
    } else if (pointers.current.size === 2) {
      beginPinch()
    }
  }, [beginPinch, localPoint, stopAnimation])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    const point = localPoint(event)
    pointers.current.set(event.pointerId, point)

    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = Array.from(pointers.current.values())
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
      const start = pinch.current
      const scale = clampScale(start.transform.scale * (distance / start.distance))
      const ratio = scale / start.transform.scale
      schedulePaint({
        scale,
        tx: center.x - ratio * (start.center.x - start.transform.tx),
        ty: center.y - ratio * (start.center.y - start.transform.ty),
      })
      return
    }

    const start = pan.current
    if (!start || start.pointerId !== event.pointerId) return
    schedulePaint({
      scale: start.transform.scale,
      tx: start.transform.tx + point.x - start.point.x,
      ty: start.transform.ty + point.y - start.point.y,
    })
  }, [localPoint, schedulePaint])

  const endPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.delete(event.pointerId)
    commitGesture()
    pinch.current = null
    pan.current = null
    const remaining = Array.from(pointers.current.entries())[0]
    if (remaining) {
      pan.current = { pointerId: remaining[0], point: remaining[1], transform: transformRef.current }
    }
  }, [commitGesture])

  const onDoubleClick = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('button, label, input, a, select, textarea, [role="button"]')) return
    event.preventDefault()
    zoomAnimated(event.shiftKey ? 1 / ZOOM_STEP : ZOOM_STEP, localPoint(event))
  }, [localPoint, zoomAnimated])

  const reset = useCallback(() => {
    manual.current = false
    pointers.current.clear()
    pan.current = null
    pinch.current = null
  }, [])

  const handlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp: endPointer,
    onPointerCancel: endPointer,
    onDoubleClick,
  }

  return {
    containerRef,
    hostRef,
    transform,
    natural,
    setNatural,
    reset,
    fit,
    zoomBy,
    actualSize,
    handlers,
  }
}

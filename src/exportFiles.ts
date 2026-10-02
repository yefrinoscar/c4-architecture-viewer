export type ExportFormat = 'dsl' | 'png' | 'svg'

export const EXPORT_FORMATS: { id: ExportFormat; label: string; extension: string; hint: string }[] = [
  { id: 'dsl', label: 'DSL', extension: '.dsl', hint: 'Fuente de Structurizr' },
  { id: 'png', label: 'PNG', extension: '.png', hint: 'Imagen rasterizada' },
  { id: 'svg', label: 'SVG', extension: '.svg', hint: 'Vector editable' },
]

export function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'dsl' || value === 'png' || value === 'svg'
}

export function exportFileName(documentName: string | undefined, format: ExportFormat, viewKey?: string): string {
  const withoutExtension = (documentName ?? 'diagrama').trim().replace(/\.[^./\\]+$/, '')
  const base = withoutExtension.replace(/[^a-zA-Z0-9_ ()[\]]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'diagrama'
  const suffix = format === 'dsl' || !viewKey ? '' : `_${viewKey.replace(/[^\w]+/g, '-')}`
  return `${base}${suffix}.${format}`
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function textBlob(text: string, mime: string): Blob {
  return new Blob([text], { type: `${mime};charset=utf-8` })
}

export async function svgToPng(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const clone = svg.cloneNode(true) as SVGSVGElement
  const viewBox = svg.viewBox.baseVal
  const width = Math.max(1, Math.round(viewBox.width || svg.clientWidth || 1))
  const height = Math.max(1, Math.round(viewBox.height || svg.clientHeight || 1))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  clone.removeAttribute('style')

  const source = new XMLSerializer().serializeToString(clone)
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('No se pudo preparar el diagrama para exportarlo a PNG.'))
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
  })

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('El navegador no permitió crear el lienzo para el PNG.')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.setTransform(scale, 0, 0, scale, 0, 0)
  context.drawImage(image, 0, 0, width, height)

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('No se pudo generar el PNG.')
  return blob
}

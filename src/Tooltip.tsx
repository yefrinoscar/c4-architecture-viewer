import type { ReactNode } from 'react'

export interface TooltipProps {
  label: string
  detail?: string
  children: ReactNode
}

export function Tooltip({ label, detail, children }: TooltipProps) {
  return (
    <span className="tip">
      {children}
      <span className="tip-bubble" role="tooltip">
        <strong>{label}</strong>
        {detail && <span className="tip-detail">{detail}</span>}
      </span>
    </span>
  )
}

import { Fragment, type ReactNode } from 'react'

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/
const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/
const BULLET = /^ {0,3}[-*+]\s+(.*)$/
const ORDERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const INLINE_SOURCE = '(`[^`]+`)|(\\*\\*[^*]+\\*\\*)|(\\*[^*\\n]+\\*)|(_[^_\\n]+_)|(\\[[^\\]\\n]+\\]\\(https?://[^)\\s]+\\))'

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = new RegExp(INLINE_SOURCE, 'g')
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const token = match[0]
    if (!token.length) break
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const key = `${keyPrefix}-${match.index}`
    const [, code, strong, star, underscore, link] = match
    if (code) {
      nodes.push(<code key={key} className="ai-md-code">{code.slice(1, -1)}</code>)
    } else if (strong) {
      nodes.push(<strong key={key}>{inline(strong.slice(2, -2), key)}</strong>)
    } else if (star || underscore) {
      nodes.push(<em key={key}>{inline(token.slice(1, -1), key)}</em>)
    } else if (link) {
      const split = link.lastIndexOf('](')
      nodes.push(
        <a key={key} href={link.slice(split + 2, -1)} target="_blank" rel="noreferrer noopener">
          {inline(link.slice(1, split), key)}
        </a>,
      )
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function blocks(text: string, dslNote: string | undefined, streaming: boolean): ReactNode[] {
  const lines = text.split('\n')
  const nodes: ReactNode[] = []
  let index = 0
  let key = 0

  while (index < lines.length) {
    const line = lines[index]

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1][0]
      const language = fence[2]
      const body: string[] = []
      index += 1
      let closed = false
      while (index < lines.length) {
        const candidate = lines[index]
        const end = FENCE.exec(candidate)
        if (end && end[1][0] === marker) {
          closed = true
          index += 1
          break
        }
        body.push(candidate)
        index += 1
      }
      if (language.toLowerCase() === 'dsl' && dslNote) {
        nodes.push(<p key={`n${key++}`} className="ai-md-note">{dslNote}</p>)
      } else {
        nodes.push(
          <pre key={`n${key++}`} tabIndex={0} aria-label={language ? `Bloque de código ${language}` : 'Bloque de código'}>
            <code>{body.join('\n')}{!closed && streaming ? '▍' : ''}</code>
          </pre>,
        )
      }
      continue
    }

    if (RULE.test(line)) {
      nodes.push(<hr key={`n${key++}`} />)
      index += 1
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const level = Math.min(heading[1].length + 2, 5)
      const Tag = `h${level}` as 'h3' | 'h4' | 'h5'
      nodes.push(<Tag key={`n${key++}`}>{inline(heading[2], `h${index}`)}</Tag>)
      index += 1
      continue
    }

    if (BULLET.test(line)) {
      const items: ReactNode[] = []
      let item = 0
      while (index < lines.length) {
        const match = BULLET.exec(lines[index])
        if (!match) break
        items.push(<li key={`i${item++}`}>{inline(match[1], `b${index}-${item}`)}</li>)
        index += 1
      }
      nodes.push(<ul key={`n${key++}`}>{items}</ul>)
      continue
    }

    if (ORDERED.test(line)) {
      const items: ReactNode[] = []
      let item = 0
      while (index < lines.length) {
        const match = ORDERED.exec(lines[index])
        if (!match) break
        items.push(<li key={`i${item++}`} value={Number(match[1])}>{inline(match[2], `o${index}-${item}`)}</li>)
        index += 1
      }
      nodes.push(<ol key={`n${key++}`}>{items}</ol>)
      continue
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index])
        if (!match) break
        quoted.push(match[1])
        index += 1
      }
      nodes.push(<blockquote key={`n${key++}`}>{blocks(quoted.join('\n'), dslNote, false)}</blockquote>)
      continue
    }

    if (!line.trim()) {
      index += 1
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim() && !FENCE.test(lines[index]) && !BULLET.test(lines[index])
      && !ORDERED.test(lines[index]) && !HEADING.test(lines[index]) && !RULE.test(lines[index])) {
      paragraph.push(lines[index])
      index += 1
    }
    nodes.push(<p key={`n${key++}`}>{inline(paragraph.join('\n'), `p${index}`)}</p>)
  }

  return nodes
}

export interface AiMarkdownProps {
  text: string
  streaming?: boolean
  dslNote?: string
}

export function AiMarkdown({ text, streaming, dslNote }: AiMarkdownProps) {
  if (!text) return null
  return (
    <div className="ai-md">
      {blocks(text, dslNote, !!streaming).map((node, index) => <Fragment key={index}>{node}</Fragment>)}
      {streaming && <span className="ai-caret" aria-hidden="true" />}
    </div>
  )
}

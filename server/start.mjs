import { createServer } from 'node:http'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAiMiddleware, requestPath, sendJson } from './go-api.mjs'
import { createChatGptAuth } from './chatgpt-auth.mjs'

const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.dsl': 'text/plain; charset=utf-8',
}

function inside(root, file) {
  const relative = path.relative(root, file)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function staticResponse(req, res, distDir) {
  let handle
  try {
    const pathname = requestPath(req)
    if (pathname === '/api' || pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Recurso de API no encontrado.' })
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD')
      return sendJson(res, 405, { error: 'Método no permitido.' })
    }
    if (pathname.split('/').some((part) => part.startsWith('.'))) return sendJson(res, 404, { error: 'Recurso no encontrado.' })
    const root = await realpath(distDir)
    let candidate = path.resolve(root, `.${pathname}`)
    if (!inside(root, candidate)) return sendJson(res, 404, { error: 'Recurso no encontrado.' })
    if (pathname.endsWith('/')) candidate = path.join(candidate, 'index.html')
    let file
    try {
      file = await realpath(candidate)
    } catch (error) {
      if (req.method !== 'GET' || !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
      file = await realpath(path.join(root, 'index.html'))
    }
    if (!inside(root, file)) return sendJson(res, 404, { error: 'Recurso no encontrado.' })
    handle = await open(file, 'r')
    const stat = await handle.stat()
    if (!stat.isFile()) {
      await handle.close()
      handle = undefined
      return sendJson(res, 404, { error: 'Recurso no encontrado.' })
    }
    if (res.destroyed) {
      await handle.close()
      return
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    })
    if (req.method === 'HEAD') {
      await handle.close()
      res.end()
      return
    }
    const stream = handle.createReadStream()
    res.once('close', () => stream.destroy())
    stream.once('error', () => res.destroy())
    stream.pipe(res)
  } catch {
    await handle?.close().catch(() => {})
    sendJson(res, 404, { error: 'Recurso no encontrado. Comprueba que exista la compilación dist.' })
  }
}

export function createProductionServer({ distDir = DIST, fetchImpl } = {}) {
  const port = Number(process.env.PORT ?? 4173)
  const chatGptAuth = createChatGptAuth({ fetchImpl, port })
  const middleware = createAiMiddleware({ fetchImpl, chatGptAuth })
  return createServer((req, res) => {
    let pathname = ''
    try { pathname = requestPath(req) } catch { sendJson(res, 400, { error: 'La ruta no es válida.' }); return }
    if (pathname === '/auth/chatgpt' && req.method === 'GET') { chatGptAuth.begin(req, res); return }
    if (pathname === '/auth/chatgpt/callback' && req.method === 'GET') {
      void chatGptAuth.callback(req, res, new URL(req.url, `http://${req.headers.host}`)).catch((error) => {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<h1>No se pudo iniciar sesión con ChatGPT</h1><p>${String(error.message).replace(/[<&>]/g, (char) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' })[char])}</p><p>Puedes cerrar esta ventana.</p>`)
      })
      return
    }
    void middleware(req, res, () => { void staticResponse(req, res, distDir) })
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4173)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write('PORT debe ser un entero entre 1 y 65535.\n')
    process.exitCode = 1
  } else {
    const server = createProductionServer()
    server.on('error', () => {
      process.stderr.write('No se pudo iniciar el servidor local. Comprueba el puerto.\n')
      process.exitCode = 1
    })
    server.listen(port, '127.0.0.1', () => {
      process.stdout.write(`Servidor local en http://127.0.0.1:${port}\n`)
    })
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        server.close()
        server.closeAllConnections()
      })
    }
  }
}

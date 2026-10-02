import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { createAiMiddleware } from './go-api.mjs'
import { createProductionServer } from './start.mjs'

const exec = promisify(execFile)
const MODEL_IDS = ['glm-test', 'kimi-test', 'deepseek-test', 'mimo-test', 'longcat-test', 'hy-test', 'minimax-test', 'qwen-test', 'union-alpha', 'grok-test', 'gpt-test', 'muse-test']
const payload = (model = 'glm-test') => ({ apiKey: 'test-key-never-real', model, sessionId: 'stable-session-123', messages: [{ role: 'user', content: 'Explica el modelo.' }], dsl: 'workspace {}' })
const chatFinish = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
const chatText = { choices: [{ index: 0, delta: { content: 'Hola español' }, finish_reason: null }] }
const messageFinish = { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
const responseFinish = { type: 'response.completed', response: { status: 'completed', output: [] } }
const frames = (events) => events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')
const sse = (events) => new Response(frames(events), { headers: { 'content-type': 'text/event-stream' } })
const modelResponse = (ids = MODEL_IDS) => Response.json({ data: ids.map((id) => ({ id })) })

function mockFetch(reply = () => sse([chatText, chatFinish, '[DONE]']), models = () => modelResponse()) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return url.endsWith('/models') ? models(options) : reply(options)
  }
  return { fetchImpl, calls }
}

async function listen(t, server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function fixture(t, options = {}) {
  const mock = mockFetch(options.reply, options.models)
  const middleware = createAiMiddleware({ fetchImpl: mock.fetchImpl, timeoutMs: options.timeoutMs })
  const server = createServer((req, res) => {
    void middleware(req, res, () => { res.writeHead(418); res.end('next') })
  })
  const base = await listen(t, server)
  const post = (body = payload(), headers = {}) => fetch(`${base}/api/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { ...mock, base, post }
}

async function events(response) {
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8')
  return (await response.text()).trim().split('\n').map((line) => JSON.parse(line))
}

function assertFailure(output) {
  assert.equal(output.at(-1).type, 'error')
  assert.equal(output.some((event) => event.type === 'done'), false)
  assert.equal(JSON.stringify(output).includes('secret-provider-detail'), false)
}

test('public models are prefix-filtered, deduplicated and cached without credentials', async (t) => {
  const f = await fixture(t, { models: () => Response.json({ data: [...MODEL_IDS.map((id) => ({ id, protocol: 'invalid' })), { id: 'unknown', protocol: 'messages' }, { id: 'glm-test' }] }) })
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${f.base}/api/ai/models`, { headers: { authorization: 'Bearer ignored-user-key', 'x-api-key': 'ignored-key' } })
    assert.equal(response.status, 200)
    const { models } = await response.json()
    assert.equal(models.length, 12)
    assert.deepEqual(models[0], { id: 'glm-test', protocol: 'chat/completions' })
    assert.deepEqual(models.find((m) => m.id === 'union-alpha'), { id: 'union-alpha', protocol: 'messages' })
    assert.deepEqual(models.at(-1), { id: 'muse-test', protocol: 'responses' })
  }
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'https://opencode.ai/zen/go/v1/models')
  assert.equal(f.calls[0].options.headers.authorization, undefined)
  assert.equal(f.calls[0].options.headers['x-api-key'], undefined)
  assert.equal(f.calls[0].options.redirect, 'error')
})

test('routing, methods, exact JSON media type and same-origin checks', async (t) => {
  const f = await fixture(t)
  assert.equal((await fetch(`${f.base}/outside`)).status, 418)
  for (const route of ['/api', '/api/nope', '/api/ai/chat/']) assert.equal((await fetch(`${f.base}${route}`)).status, 404)
  assert.equal((await fetch(`${f.base}/api/ai/chat`)).status, 405)
  assert.equal((await fetch(`${f.base}/api/ai/models`, { method: 'POST' })).status, 405)
  for (const origin of ['null', 'https://evil.invalid', `${f.base}.evil.invalid`, f.base.replace('http:', 'https:'), `${f.base}/bad`]) {
    assert.equal((await f.post(payload(), { origin })).status, 403)
    assert.equal((await fetch(`${f.base}/api/ai/models`, { headers: { origin } })).status, 403)
  }
  for (const type of ['text/plain', 'application/jsonx', 'text/plain; application/json']) assert.equal((await f.post(payload(), { 'content-type': type })).status, 415)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.post(payload(), { origin: f.base, 'content-type': 'Application/JSON; charset=utf-8' })).status, 200)
})

test('missing authentication, malformed bodies, history, DSL, model and session bounds reject before fetch', async (t) => {
  const f = await fixture(t)
  const missing = payload()
  delete missing.apiKey
  assert.equal((await f.post(missing)).status, 401)
  const invalid = [
    { apiKey: 'x'.repeat(1000) }, { apiKey: 'bad\nkey' }, { apiKey: 'bad\rkey' }, { apiKey: ' ' },
    { model: 'unknown' }, { model: 'glm/../../test' },
    { sessionId: '' }, { sessionId: 'a'.repeat(129) }, { sessionId: 'bad\nsession' }, { sessionId: '../bad' },
    { dsl: 'x'.repeat(500001) }, { dsl: null },
    { messages: [] }, { messages: Array.from({ length: 21 }, () => ({ role: 'user', content: '' })) },
    { messages: [{ role: 'system', content: 'bad' }] }, { messages: [{ role: 'user', content: 1 }] },
    { messages: [{ role: 'user', content: 'x'.repeat(50001) }, { role: 'assistant', content: 'x'.repeat(50000) }] },
  ]
  for (const item of invalid) {
    const response = await f.post({ ...payload(), ...item })
    assert.equal(response.status, 400, JSON.stringify(Object.keys(item)))
    assert.equal(typeof (await response.json()).error, 'string')
  }
  for (const body of ['{', 'null', '[]']) assert.equal((await fetch(`${f.base}/api/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 400)
  assert.equal(f.calls.length, 0)
})

test('request byte limit returns 413 for fixed and chunked bodies', async (t) => {
  const f = await fixture(t)
  const body = ' '.repeat(1024 * 1024 + 1)
  assert.equal((await fetch(`${f.base}/api/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 413)
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(`${f.base}/api/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.write(body.slice(0, 600000))
    req.end(body.slice(600000))
  })
  assert.equal(response, 413)
  assert.equal(f.calls.length, 0)
})

test('exact valid bounds and UUID sessions are accepted', async (t) => {
  const f = await fixture(t)
  const input = { ...payload(), apiKey: 'a'.repeat(999), sessionId: '7b178606-1710-4a31-9ea6-5b08428b9f50', dsl: 'd'.repeat(500000), messages: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: 'x'.repeat(5000) })) }
  assert.equal((await events(await f.post(input))).at(-1).type, 'done')
})

test('registry and public list both required; list errors fail closed without paid calls', async (t) => {
  for (const models of [() => modelResponse([]), () => modelResponse(['kimi-test']), () => new Response('secret-provider-detail', { status: 503 }), () => Response.json({ nope: [] })]) {
    const f = await fixture(t, { models })
    const response = await f.post()
    assert.ok([400, 502].includes(response.status))
    assert.equal((await response.text()).includes('secret-provider-detail'), false)
    assert.equal(f.calls.length, 1)
    assert.ok(f.calls[0].url.endsWith('/models'))
  }
})

for (const [model, protocol, stream] of [
  ['glm-test', 'chat/completions', [chatText, { choices: [{ delta: { reasoning_content: 'hidden' } }] }, chatFinish, '[DONE]']],
  ['union-alpha', 'messages', [{ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hola español' } }, messageFinish, { type: 'message_stop' }]],
  ['gpt-test', 'responses', [{ type: 'response.reasoning_text.delta', delta: 'hidden' }, { type: 'response.output_text.delta', delta: 'Hola español' }, responseFinish]],
]) {
  test(`${protocol}: NDJSON deltas, protocol body, auth and stable session headers`, async (t) => {
    const f = await fixture(t, { reply: () => sse(stream) })
    for (let i = 0; i < 2; i++) assert.deepEqual(await events(await f.post(payload(model))), [{ type: 'delta', text: 'Hola español' }, { type: 'done' }])
    const calls = f.calls.filter((call) => !call.url.endsWith('/models'))
    assert.equal(calls.length, 2)
    for (const { url, options } of calls) {
      assert.equal(url, `https://opencode.ai/zen/go/v1/${protocol}`)
      assert.equal(options.headers['x-opencode-session'], 'stable-session-123')
      assert.equal(options.headers['user-agent'], 'atlas-c4-coding-agent/1.0')
      assert.equal(options.redirect, 'error')
      assert.equal(options.headers[protocol === 'messages' ? 'x-api-key' : 'authorization'], protocol === 'messages' ? payload().apiKey : `Bearer ${payload().apiKey}`)
      assert.equal(options.headers[protocol === 'messages' ? 'authorization' : 'x-api-key'], undefined)
      const body = JSON.parse(options.body)
      assert.equal(body.stream, true)
      assert.equal(body.model, model)
      assert.equal(body.tools, undefined)
      assert.equal(options.body.includes(payload().apiKey), false)
      const instructions = body.system ?? body.instructions ?? body.messages[0].content
      assert.match(instructions, /español/)
      assert.match(instructions, /DSL COMPLETO/)
      assert.match(instructions, /no confiable/)
      assert.match(instructions, /Nunca ejecutes/)
      assert.equal(instructions.includes(payload().dsl), false)
      assert.ok(options.body.includes('workspace {}'))
    }
  })
}

test('SSE handles split UTF-8, CRLF, comments and multiline data', async (t) => {
  const raw = `: keepalive\r\nevent: message\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"ñ"}}]}\r\n\r\n${frames([chatFinish, '[DONE]']).replaceAll('\n', '\r\n')}`
  const bytes = new TextEncoder().encode(raw)
  const f = await fixture(t, { reply: () => new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } }) })
  assert.deepEqual(await events(await f.post()), [{ type: 'delta', text: 'ñ' }, { type: 'done' }])
})

test('provider HTTP errors are redacted and never retried', async (t) => {
  for (const status of [400, 401, 403, 429, 500, 302]) {
    const f = await fixture(t, { reply: () => new Response('secret-provider-detail test-key-never-real', { status }) })
    const output = await events(await f.post())
    assertFailure(output)
    assert.equal(JSON.stringify(output).includes(payload().apiKey), false)
    assert.equal(f.calls.length, 2)
  }
})

test('in-stream errors, invalid/truncated events and incomplete stop reasons never emit done', async (t) => {
  const cases = [
    ['glm-test', sse([{ error: { message: 'secret-provider-detail' } }])],
    ['glm-test', sse([chatText])],
    ['glm-test', sse(['[DONE]'])],
    ['glm-test', sse([{ choices: [{ finish_reason: 'length' }] }, '[DONE]'])],
    ['glm-test', sse([{ choices: [{ finish_reason: 'content_filter' }] }])],
    ['glm-test', sse([{ choices: [{ delta: { tool_calls: [] } }] }])],
    ['glm-test', sse(['{bad'])],
    ['glm-test', new Response(`${frames([chatFinish])}data: {`, { headers: { 'content-type': 'text/event-stream' } })],
    ['glm-test', new Response('event: error\n\n', { headers: { 'content-type': 'text/event-stream' } })],
    ['glm-test', Response.json({ choices: [] })],
    ['union-alpha', sse([{ type: 'message_stop' }])],
    ['union-alpha', sse([messageFinish])],
    ['union-alpha', sse([{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }])],
    ['union-alpha', sse([{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }])],
    ['union-alpha', sse([{ type: 'error', error: { message: 'secret-provider-detail' } }])],
    ['gpt-test', sse([{ type: 'response.incomplete' }])],
    ['gpt-test', sse([{ type: 'response.failed' }])],
    ['gpt-test', sse([{ type: 'response.completed', response: { status: 'incomplete' } }])],
    ['gpt-test', sse([{ type: 'response.completed', response: { status: 'completed', incomplete_details: { reason: 'max_output_tokens' } } }])],
  ]
  for (const [model, response] of cases) {
    const f = await fixture(t, { reply: () => response })
    assertFailure(await events(await f.post(payload(model))))
  }
})

test('upstream model and streaming response byte caps cancel readers', async (t) => {
  let cancelled = false
  const f = await fixture(t, { reply: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) },
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'text/event-stream' } }) })
  assertFailure(await events(await f.post()))
  assert.equal(cancelled, true)
  const g = await fixture(t, { models: () => new Response('x'.repeat(1024 * 1024 + 1)) })
  assert.equal((await fetch(`${g.base}/api/ai/models`)).status, 502)
})

test('timeouts cancel a stalled stream and emit error instead of done', async (t) => {
  let cancelled = false
  let signal
  const f = await fixture(t, { timeoutMs: 60, reply: (options) => {
    signal = options.signal
    return new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const output = await events(await f.post())
  assertFailure(output)
  assert.match(output.at(-1).message, /tiempo de espera/)
  assert.equal(signal.aborted, true)
  assert.equal(cancelled, true)
})

test('disconnect aborts upstream fetch and cancels the reader', async (t) => {
  let upstreamSignal
  let resolveCancel
  const cancelled = new Promise((resolve) => { resolveCancel = resolve })
  const f = await fixture(t, { reply: (options) => {
    upstreamSignal = options.signal
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(frames([chatText]))) },
      cancel() { resolveCancel() },
    }), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const controller = new AbortController()
  const response = await fetch(`${f.base}/api/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload()), signal: controller.signal })
  await response.body.getReader().read()
  controller.abort()
  await Promise.race([cancelled, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('disconnect did not cancel')), 1000); timer.unref() })])
  assert.equal(upstreamSignal.aborted, true)
})

test('production serves MIME and GET SPA fallback, blocks API fallback and traversal/symlinks', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'atlas-bridge-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dist = path.join(dir, 'dist')
  await mkdir(dist)
  await writeFile(path.join(dist, 'index.html'), '<html>app</html>')
  await writeFile(path.join(dist, 'app.js'), 'export {}')
  await writeFile(path.join(dist, 'app.css'), 'body{}')
  await writeFile(path.join(dist, 'font.woff2'), 'font')
  await writeFile(path.join(dist, 'icon.svg'), '<svg/>')
  await writeFile(path.join(dir, 'private.txt'), 'private-secret')
  await symlink(path.join(dir, 'private.txt'), path.join(dist, 'escape.txt'))
  const mock = mockFetch()
  const base = await listen(t, createProductionServer({ distDir: dist, fetchImpl: mock.fetchImpl }))
  for (const [file, mime] of [['app.js', 'text/javascript'], ['app.css', 'text/css'], ['font.woff2', 'font/woff2'], ['icon.svg', 'image/svg+xml']]) {
    const response = await fetch(`${base}/${file}`)
    assert.equal(response.status, 200)
    assert.ok(response.headers.get('content-type').startsWith(mime))
  }
  assert.equal(await (await fetch(`${base}/deep/spa/route`)).text(), '<html>app</html>')
  assert.equal((await fetch(`${base}/deep/spa/route`, { method: 'HEAD' })).status, 404)
  assert.equal((await fetch(`${base}/deep/spa/route`, { method: 'POST' })).status, 405)
  assert.equal((await fetch(`${base}/api/nope`)).status, 404)
  assert.equal((await fetch(`${base}/escape.txt`)).status, 404)
  for (const route of ['/../private.txt', '/%2e%2e%2fprivate.txt', '/%00', '/%ZZ', '/.env', '//host/path', '/%5c..%5cprivate.txt']) {
    const { stdout } = await exec('curl', ['--silent', '--path-as-is', '--write-out', '\n%{http_code}', `${base}${route}`])
    assert.match(stdout, /\n40[04]$/)
    assert.equal(stdout.includes('private-secret'), false)
  }
})

test('Vite dev and preview expose exact same-origin chat route with mocked provider', async (t) => {
  const vite = await import('vite')
  const originalFetch = globalThis.fetch
  const mock = mockFetch()
  globalThis.fetch = mock.fetchImpl
  t.after(() => { globalThis.fetch = originalFetch })
  const dev = await vite.createServer({ server: { port: 0, host: '127.0.0.1' } })
  t.after(() => dev.close())
  await dev.listen()
  const preview = await vite.preview({ preview: { port: 0, host: '127.0.0.1' } })
  t.after(() => new Promise((resolve) => { preview.httpServer.closeAllConnections(); preview.httpServer.close(resolve) }))
  for (const server of [dev, preview]) {
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    const { stdout } = await exec('curl', ['--silent', '--show-error', '--fail', '-H', 'Content-Type: application/json', '-H', `Origin: ${base}`, '--data-binary', JSON.stringify(payload()), `${base}/api/ai/chat`])
    assert.deepEqual(stdout.trim().split('\n').map((line) => JSON.parse(line)), [{ type: 'delta', text: 'Hola español' }, { type: 'done' }])
  }
  assert.equal(mock.calls.filter((call) => !call.url.endsWith('/models')).length, 2)
})

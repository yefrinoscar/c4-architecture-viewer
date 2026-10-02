import { createHash, randomBytes } from 'node:crypto'
import { jwtVerify, createRemoteJWKSet } from 'jose'

const ISSUER = 'https://auth.openai.com'
const AUTHORIZATION = `${ISSUER}/api/accounts/authorize`
const TOKEN = `${ISSUER}/api/accounts/oauth/token`
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`))
const API = 'https://api.openai.com/v1'

function randomValue(bytes = 32) { return randomBytes(bytes).toString('base64url') }
function cookie(req, name) {
  return req.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1)
}

export function createChatGptAuth({ fetchImpl = globalThis.fetch, port = 4173 } = {}) {
  const hostId = process.env.OPENAI_SIWC_HOST_ID
  const redirectUri = process.env.OPENAI_SIWC_REDIRECT_URI ?? `http://127.0.0.1:${port}/auth/chatgpt/callback`
  const attempts = new Map()
  let credentials = null

  const enabled = Boolean(hostId)
  const status = () => credentials
    ? { enabled, signedIn: true, email: credentials.email ?? null, name: credentials.name ?? null }
    : { enabled, signedIn: false }

  async function tokenRequest(body) {
    const response = await fetchImpl(TOKEN, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    })
    if (!response.ok) throw new Error('ChatGPT no pudo completar la autorización.')
    return response.json()
  }

  async function verify(idToken, clientId, nonce) {
    const { payload } = await jwtVerify(idToken, JWKS, { issuer: ISSUER, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 })
    if (payload.nonce !== nonce || typeof payload.sub !== 'string') throw new Error('La identidad de ChatGPT no pudo verificarse.')
    return payload
  }

  function begin(req, res) {
    if (!enabled) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Configura OPENAI_SIWC_HOST_ID antes de iniciar sesión.'); return }
    const browser = randomValue(24)
    const state = randomValue()
    const nonce = randomValue()
    const verifier = randomValue(64)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    attempts.set(browser, { state, nonce, verifier, redirectUri, clientId: 'dynamic_agent_client', expiresAt: Date.now() + 10 * 60 * 1000 })
    const url = new URL(AUTHORIZATION)
    url.search = new URLSearchParams({
      client_id: 'dynamic_agent_client', agent_name_hint: process.env.OPENAI_SIWC_AGENT_NAME ?? 'C4Example C4 Viewer',
      ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectUri,
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: API, state, nonce, code_challenge_method: 'S256', code_challenge: challenge,
    })
    const secure = redirectUri.startsWith('https://') ? '; Secure' : ''
    res.writeHead(302, { Location: url, 'Set-Cookie': `c4viewer-oauth=${browser}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=600` })
    res.end()
  }

  async function callback(req, res, url) {
    const browser = cookie(req, 'c4viewer-oauth')
    const attempt = browser ? attempts.get(browser) : null
    if (browser) attempts.delete(browser)
    if (!attempt || attempt.expiresAt < Date.now() || url.searchParams.get('state') !== attempt.state) throw new Error('La autorización expiró o no es válida.')
    if (url.searchParams.get('error')) throw new Error('La autorización de ChatGPT fue cancelada.')
    const code = url.searchParams.get('code')
    const clientId = url.searchParams.get('client_id')
    if (!code || !clientId || clientId === 'dynamic_agent_client') throw new Error('ChatGPT no devolvió un client ID válido.')
    const tokens = await tokenRequest({ grant_type: 'authorization_code', code, client_id: clientId, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: API })
    if (typeof tokens.id_token !== 'string' || typeof tokens.access_token !== 'string') throw new Error('La respuesta de ChatGPT no contiene credenciales válidas.')
    const identity = await verify(tokens.id_token, clientId, attempt.nonce)
    const scopes = String(tokens.scope ?? '').split(/\s+/).filter(Boolean)
    if (!scopes.includes('chatgpt.tokens.use.direct')) throw new Error('No se autorizó el uso del plan de ChatGPT para IA.')
    credentials = { ...tokens, clientId, sub: identity.sub, email: identity.email, name: identity.name, savedAt: Date.now() }
    res.writeHead(302, { Location: '/', 'Set-Cookie': 'c4viewer-oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' })
    res.end()
  }

  async function accessToken() {
    if (!credentials) return null
    if (credentials.expires_in && Date.now() < credentials.savedAt + (credentials.expires_in - 60) * 1000) return credentials.access_token
    if (!credentials.refresh_token) return credentials.access_token
    const next = await tokenRequest({ grant_type: 'refresh_token', refresh_token: credentials.refresh_token, client_id: credentials.clientId, resource: API })
    credentials = { ...credentials, ...next, savedAt: Date.now() }
    return credentials.access_token
  }

  return { enabled, status, begin, callback, logout: () => { credentials = null }, accessToken, apiBase: API }
}

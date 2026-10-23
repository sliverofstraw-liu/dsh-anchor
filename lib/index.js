/**
 * Host half of dsh-anchor.
 *
 * The client half knows what the reader is pointing at; the host half is the only
 * side that can see the prompt. This module bridges the two:
 *
 *   browser --POST /dsh-anchor/state--> here --systemPrompt.context()--> every model step
 *
 * The prompt contribution is a function, so it is re-resolved on each assembly:
 * the anchor is whatever the browser reported last, not a value frozen at boot.
 *
 * Failure policy: the host is all-or-nothing at boot, so every registration is
 * wrapped. A broken anchor must never keep the app from starting.
 */

export const name = 'dsh-anchor'

/** Both are core web-profile services; without them this plugin has no job. */
export const inject = ['webServer', 'systemPrompt']

const MAX_BODY = 64 * 1024
const MAX_QUOTE = 4000
const CONTEXT_ORDER = 95

/** sessionId -> reported anchor (memory only; the browser owns the source of truth). */
const anchors = new Map()

function isLoopback(request) {
  const address = request.socket === undefined ? '' : request.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function send(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function cleanText(value, limit) {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n/g, '\n').trim().slice(0, limit)
}

function normalize(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const quote = cleanText(raw.quote, MAX_QUOTE)
  if (quote === '') return null
  return {
    sessionId: cleanText(raw.sessionId, 200),
    kind: raw.kind === 'point' ? 'point' : 'quote',
    quote,
    context: cleanText(raw.context, MAX_QUOTE),
    position: cleanText(raw.position, 300),
    at: Date.now(),
  }
}

/**
 * The text the model receives. Kept plain and explicit: it states what the
 * question points at, quotes it, and marks the exact fragment the reader picked.
 */
function renderAnchor(anchor) {
  const lines = []
  lines.push('### Current question anchor')
  lines.push('')
  lines.push('The user is reading the transcript and their next question is about the passage below,')
  lines.push('not about the whole conversation. Answer in terms of that passage first.')
  lines.push('')
  if (anchor.position !== '') lines.push(`Where: ${anchor.position}`)
  lines.push('')
  lines.push('Quoted passage:')
  lines.push('> ' + anchor.quote.replace(/\n/g, '\n> '))
  if (anchor.context !== '' && anchor.context !== anchor.quote) {
    lines.push('')
    lines.push('Surrounding context:')
    lines.push('> ' + anchor.context.replace(/\n/g, '\n> '))
  }
  if (anchor.kind === 'point') {
    lines.push('')
    lines.push('The reader did not select words: this is a position marker for the passage above.')
  }
  return lines.join('\n')
}

function lookup(context) {
  const session = context === undefined || context.agent === undefined ? undefined : context.agent.session
  const id = session === undefined || session === null ? '' : String(session.id ?? '')
  const direct = anchors.get(id)
  if (direct !== undefined) return direct
  // Only one reader is typing at a time on a desktop; a single stored anchor is
  // still the right one when the session ids do not line up.
  if (anchors.size === 1) return [...anchors.values()][0]
  return undefined
}

export function apply(ctx) {
  try {
    ctx.systemPrompt.context({
      name: 'dsh-anchor:current',
      order: CONTEXT_ORDER,
      interpolate: false,
      text: (context) => {
        try {
          const anchor = lookup(context)
          return anchor === undefined ? '' : renderAnchor(anchor)
        } catch {
          return ''
        }
      },
    })
  } catch (error) {
    console.warn('[dsh-anchor] system prompt hook failed', error)
  }

  try {
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-anchor/state',
      handler: async (request, response) => {
        if (!isLoopback(request)) {
          send(response, 403, { ok: false, error: 'loopback only' })
          return
        }
        if (request.method !== 'POST') {
          send(response, 405, { ok: false, error: 'POST only' })
          return
        }
        try {
          const anchor = normalize(JSON.parse(await readBody(request)))
          if (anchor === null) {
            send(response, 400, { ok: false, error: 'quote is required' })
            return
          }
          anchors.set(anchor.sessionId, anchor)
          send(response, 200, { ok: true, sessions: anchors.size })
        } catch (error) {
          send(response, 400, { ok: false, error: String(error instanceof Error ? error.message : error) })
        }
      },
    })
  } catch (error) {
    console.warn('[dsh-anchor] state route failed', error)
  }

  try {
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-anchor/clear',
      handler: async (request, response) => {
        if (!isLoopback(request)) {
          send(response, 403, { ok: false, error: 'loopback only' })
          return
        }
        let sessionId = ''
        try {
          const body = await readBody(request)
          const parsed = body === '' ? {} : JSON.parse(body)
          sessionId = cleanText(parsed.sessionId, 200)
        } catch {
          sessionId = ''
        }
        if (sessionId === '') anchors.clear()
        else anchors.delete(sessionId)
        send(response, 200, { ok: true, sessions: anchors.size })
      },
    })
  } catch (error) {
    console.warn('[dsh-anchor] clear route failed', error)
  }

  // 只读调试接口：界面上的隐藏面板（Ctrl+Alt+D）用它显示「这一轮到底注入了什么」。
  // 不写任何状态，只接受本机请求。
  try {
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-anchor/debug',
      handler: async (request, response) => {
        if (!isLoopback(request)) {
          send(response, 403, { ok: false, error: 'loopback only' })
          return
        }
        const list = [...anchors.entries()].map(([sessionId, anchor]) => ({ sessionId, ...anchor }))
        send(response, 200, {
          ok: true,
          sessions: anchors.size,
          anchors: list,
          rendered: list.length === 0 ? '' : renderAnchor(list[list.length - 1]),
        })
      },
    })
  } catch (error) {
    console.warn('[dsh-anchor] debug route failed', error)
  }
}

/**
 * Web half of dsh-anchor.
 *
 * Hand-written against the client module loader: the host serves this file, the
 * shell evaluates it, and `__ModuleLoader__` hands the factory a `require` bound
 * to the module table (react, react-dom, cordis, ui-primitives, ...). No bundler.
 *
 * What it does:
 *   - drag-select inside the transcript -> a small bar (提问 / 复制)
 *   - 提问 turns the selection into an anchor and reports it to the host half,
 *     which folds it into the system prompt for the next model step
 *   - anchors persist per session, paint as translucent rectangles, and leave a
 *     pin label on the answer they produced
 */
window.__ModuleLoader__.load({
  id: 'dsh-anchor',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    //#region constants
    const SLOT_OVERLAY = 'shell.overlay'
    const SLOT_TOOLS = 'conversation.input.left'
    const SLOT_ANSWER = 'conversation.chat.assistant-actions'

    const MAX_CHIPS = 3
    const MAX_QUESTIONS = 60
    const SELECT_DELAY = 150

    const TRANSCRIPT = '[data-conversation-scroll]'
    const CHAT_NODE = '[data-slot="conversation.chat.node"]'
    const USER_TEXT = '[data-slot="conversation.user.text.node"]'

    /** 插件自己的 DOM 都带这个属性，文字检索会跳过，避免把界面文案当正文。 */
    const UI_ATTR = 'data-dsh-anchor-ui'
    /** 贴在 assistant 消息容器上的消息 id。 */
    const MID_ATTR = 'data-dsh-anchor-mid'
    /** 贴在用户消息上的提问标记；值是提问记录 id，`~none` 表示这次没带锚。 */
    const Q_TAG = 'data-dsh-anchor-q'
    const NONE_TAG = '~none'

    const STORAGE_PREFIX = 'dsh-anchor:v2:'
    const HIDDEN_KEY = 'dsh-anchor:v2:hidden'

    const BLOCK_TAGS = ['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'PRE', 'BLOCKQUOTE']
    //#endregion

    //#region state
    /** 每个会话一份：chips 是正在问，asked 是问过。 */
    const buckets = new Map()
    let activeKey = ''
    let state = bucketOf('')
    let snapshot = { chips: [], asked: [], hidden: false }
    let seq = 0
    let hidden = readHidden()
    const listeners = new Set()

    /** 刚发出、还没贴到用户消息上的提问记录 id。 */
    let pendingQuestionId = null
    /** id -> 提问记录；记录贴在用户消息上，回答按文档顺序推出。 */
    const questionRecords = new Map()

    function bucketOf(key) {
      let bucket = buckets.get(key)
      if (bucket === undefined) {
        bucket = { chips: [], asked: [] }
        buckets.set(key, bucket)
      }
      return bucket
    }

    function readHidden() {
      try {
        return window.localStorage.getItem(HIDDEN_KEY) === '1'
      } catch {
        return false
      }
    }

    function isHidden() {
      return hidden
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function getSnapshot() {
      return snapshot
    }

    function emit() {
      snapshot = { chips: state.chips.slice(), asked: state.asked.slice(), hidden }
      persist()
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.warn('[dsh-anchor] listener failed', error)
        }
      }
    }

    /** 让某条 chip 闪一下：重复引用、或已满额时的反馈。 */
    const flashListeners = new Set()
    function flash(id) {
      for (const listener of [...flashListeners]) {
        try {
          listener(id)
        } catch (error) {
          console.warn('[dsh-anchor] flash listener failed', error)
        }
      }
    }
    //#endregion

    //#region persistence
    function persistable(entry) {
      return {
        id: entry.id,
        kind: entry.kind,
        quote: entry.quote,
        sent: entry.sent === true,
        offsetInRoot: entry.offsetInRoot,
        context: entry.context,
        position: entry.position,
        messageIndex: entry.messageIndex,
        messageId: entry.messageId,
      }
    }

    function persist() {
      if (activeKey === '') return
      try {
        window.localStorage.setItem(
          `${STORAGE_PREFIX}${activeKey}`,
          JSON.stringify({
            chips: state.chips.map(persistable),
            asked: state.asked.map(persistable),
            questions: [...questionRecords.values()].slice(-MAX_QUESTIONS),
          }),
        )
      } catch {
        /* 配额或隐私模式：不影响主流程 */
      }
    }

    function restoreList(raw) {
      if (!Array.isArray(raw)) return []
      return raw
        .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.quote === 'string')
        .slice(0, MAX_CHIPS)
        .map((entry) => ({
          id: typeof entry.id === 'string' ? entry.id : `c${(seq += 1)}`,
          kind: entry.kind === 'point' ? 'point' : 'quote',
          quote: entry.quote,
          sent: entry.sent === true,
          scope: null,
          element: null,
          offsetIn: -1,
          offsetInRoot: typeof entry.offsetInRoot === 'number' ? entry.offsetInRoot : -1,
          context: typeof entry.context === 'string' ? entry.context : '',
          position: typeof entry.position === 'string' ? entry.position : '',
          messageIndex: typeof entry.messageIndex === 'number' ? entry.messageIndex : -1,
          messageId: typeof entry.messageId === 'string' ? entry.messageId : '',
        }))
    }

    function restoreQuestions(raw) {
      if (!Array.isArray(raw)) return
      for (const value of raw.slice(-MAX_QUESTIONS)) {
        if (value === null || typeof value !== 'object' || typeof value.quote !== 'string') continue
        const id = typeof value.id === 'string' ? value.id : `q${(seq += 1)}`
        questionRecords.set(id, {
          id,
          quote: value.quote,
          kind: value.kind === 'point' ? 'point' : 'quote',
          offsetInRoot: typeof value.offsetInRoot === 'number' ? value.offsetInRoot : -1,
          context: typeof value.context === 'string' ? value.context : '',
          position: typeof value.position === 'string' ? value.position : '',
          userIndex: typeof value.userIndex === 'number' ? value.userIndex : -1,
          at: typeof value.at === 'number' ? value.at : 0,
        })
      }
    }

    /** 读某会话的存档；内存里已经有数据就不覆盖。 */
    function hydrate(key) {
      const bucket = bucketOf(key)
      if (bucket.chips.length > 0 || bucket.asked.length > 0) return bucket
      try {
        const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${key}`)
        if (raw !== null) {
          const parsed = JSON.parse(raw)
          bucket.chips = restoreList(parsed?.chips)
          bucket.asked = restoreList(parsed?.asked)
          restoreQuestions(parsed?.questions)
        }
      } catch {
        /* 坏数据当作没有 */
      }
      return bucket
    }
    //#endregion

    //#region transcript text
    function collectText(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const value = node.nodeValue
          if (value === null || value.trim() === '') return NodeFilter.FILTER_REJECT
          const parent = node.parentElement
          if (parent === null) return NodeFilter.FILTER_REJECT
          if (parent.closest(`[${UI_ATTR}]`) !== null) return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        },
      })
      const nodes = []
      let text = ''
      let node = walker.nextNode()
      while (node !== null) {
        nodes.push({ node, start: text.length })
        text += node.nodeValue
        node = walker.nextNode()
      }
      return { nodes, text }
    }

    function positionOf(nodes, offset) {
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const entry = nodes[index]
        const length = entry.node.nodeValue.length
        if (offset >= entry.start && offset <= entry.start + length) {
          return { node: entry.node, offset: offset - entry.start }
        }
      }
      return null
    }

    /**
     * 正文 + 一张「去掉空白后的下标 → 原始下标」的映射。
     * 引用文字来自 textContent，节点拼接时的空白未必一致，所以比对一律忽略空白。
     */
    function indexTranscript(root) {
      const { nodes, text } = collectText(root)
      let compressed = ''
      const map = []
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        if (/\s/.test(char)) continue
        map.push(index)
        compressed += char
      }
      return { nodes, text, compressed, map }
    }

    function rangeFromOffsets(nodes, startOffset, endOffset) {
      const start = positionOf(nodes, startOffset)
      const end = positionOf(nodes, endOffset)
      if (start === null || end === null) return null
      const range = document.createRange()
      try {
        range.setStart(start.node, start.offset)
        range.setEnd(end.node, end.offset)
      } catch {
        return null
      }
      return range
    }

    function compress(value) {
      return String(value || '').replace(/\s+/g, '')
    }

    function commonSuffix(left, right) {
      let n = 0
      while (n < left.length && n < right.length && left[left.length - 1 - n] === right[right.length - 1 - n]) n += 1
      return n
    }

    function commonPrefix(left, right) {
      let n = 0
      while (n < left.length && n < right.length && left[n] === right[n]) n += 1
      return n
    }

    function findMatches(container, needle) {
      const data = indexTranscript(container)
      const hits = []
      let at = data.compressed.indexOf(needle)
      while (at >= 0 && hits.length < 200) {
        const startOffset = data.map[at]
        const endOffset = data.map[at + needle.length - 1]
        if (startOffset !== undefined && endOffset !== undefined) {
          hits.push({ startOffset, endOffset: endOffset + 1, data })
        }
        at = data.compressed.indexOf(needle, at + 1)
      }
      return hits
    }

    /** 候选命中像不像原来那一处：比对引用前后的文字。 */
    function contextScore(text, hit, entry) {
      const context = compress(entry.context)
      const quote = compress(entry.quote)
      if (context === '' || quote === '') return 0
      const at = context.indexOf(quote)
      if (at < 0) return 0
      const before = context.slice(Math.max(0, at - 24), at)
      const after = context.slice(at + quote.length, at + quote.length + 24)
      const actualBefore = compress(text.slice(Math.max(0, hit.startOffset - 48), hit.startOffset))
      const actualAfter = compress(text.slice(hit.endOffset, hit.endOffset + 48))
      return commonSuffix(before, actualBefore) + commonPrefix(after, actualAfter)
    }

    function textOffsetOf(container, node, offset) {
      const { nodes } = collectText(container)
      for (const entry of nodes) {
        if (entry.node === node) return entry.start + offset
      }
      if (node !== null && node.nodeType === 1) {
        for (const entry of nodes) {
          if (node.contains(entry.node)) return entry.start
        }
      }
      return -1
    }
    //#endregion

    //#region anchor location
    function messageScopeOf(element, fallback) {
      if (element === null) return fallback
      return element.closest(CHAT_NODE) ?? fallback
    }

    function messageIndexOf(element) {
      const root = document.querySelector(TRANSCRIPT)
      if (root === null || element === null) return -1
      return Array.from(root.querySelectorAll(CHAT_NODE)).indexOf(element)
    }

    function messageIdOf(element) {
      const message = element === null ? null : element.closest(CHAT_NODE)
      if (message === null) return ''
      return message.getAttribute(MID_ATTR) ?? ''
    }

    function blockOf(element) {
      if (element === null) return null
      let block = element
      while (block !== null && !BLOCK_TAGS.includes(block.tagName)) block = block.parentElement
      return block ?? element
    }

    function blockTextOf(element) {
      const block = blockOf(element)
      if (block === null) return ''
      return (block.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400)
    }

    /** 人话描述锚点位置：第几条消息 + 同一条消息里最近的小标题。 */
    function describePosition(anchorNode, scopeEl, root) {
      if (root === null) return ''
      const parts = []
      const messages = Array.from(root.querySelectorAll(CHAT_NODE))
      const index = messages.indexOf(scopeEl)
      if (index >= 0) parts.push(`第 ${index + 1} 条消息`)
      const reference = anchorNode ?? scopeEl
      let heading = ''
      for (const node of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
        if (node.closest('blockquote') !== null) continue
        if (node === reference) continue
        if ((node.compareDocumentPosition(reference) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) continue
        if (scopeEl === null || !scopeEl.contains(node)) continue
        const label = (node.textContent || '').trim().slice(0, 40)
        if (label !== '') heading = label
      }
      if (heading !== '') parts.push(`小节「${heading}」`)
      return parts.join(' · ')
    }

    function messageElementById(root, id) {
      for (const node of root.querySelectorAll(`[${MID_ATTR}]`)) {
        if (node.getAttribute(MID_ATTR) === id) return node
      }
      return null
    }

    /**
     * 把一条锚重新定位成 Range。
     *
     * 文字、偏移、DOM 节点都会被重渲染打断，所以容器按精确度从高到低挑：
     * 段落节点 → 消息 id → 消息容器 → 第几条消息 → 整篇正文。
     */
    function locateEntry(root, entry) {
      const needle = compress(entry.quote)
      if (needle === '') return null
      const live = (element) => element instanceof Element && document.contains(element) && root.contains(element)

      let container = root
      let target = -1
      const byId = entry.messageId === undefined || entry.messageId === '' ? null : messageElementById(root, entry.messageId)
      if (live(entry.element)) {
        container = entry.element
      } else if (byId !== null) {
        container = byId
      } else if (live(entry.scope)) {
        container = entry.scope
        target = typeof entry.offsetIn === 'number' ? entry.offsetIn : -1
      } else {
        const messages = root.querySelectorAll(CHAT_NODE)
        const indexed = typeof entry.messageIndex === 'number' ? messages[entry.messageIndex] : undefined
        if (indexed !== undefined) container = indexed
        else target = typeof entry.offsetInRoot === 'number' ? entry.offsetInRoot : -1
      }

      const attempts = [needle.length]
      if (needle.length > 24) attempts.push(24)
      if (needle.length > 12) attempts.push(12)

      /** 在一个容器里按「整段 → 前缀」依次尝试，命中多个时用上下文/偏移挑一个。 */
      const search = (scope) => {
        for (const length of attempts) {
          const hits = findMatches(scope, needle.slice(0, length))
          if (hits.length === 0) continue
          let chosen = hits[0]
          if (hits.length > 1) {
            let bestScore = -1
            let bestHit = null
            for (const hit of hits) {
              const score = contextScore(hit.data.text, hit, entry)
              if (score > bestScore) {
                bestScore = score
                bestHit = hit
              }
            }
            if (bestHit !== null && bestScore > 0) {
              chosen = bestHit
            } else if (target >= 0) {
              let best = Number.POSITIVE_INFINITY
              for (const hit of hits) {
                const distance = Math.abs(hit.startOffset - target)
                if (distance < best) {
                  best = distance
                  chosen = hit
                }
              }
            }
          }
          const range = rangeFromOffsets(chosen.data.nodes, chosen.startOffset, chosen.endOffset)
          if (range !== null) return range
        }
        return null
      }

      // 选定的容器里没找到，就退回整篇正文再试一次——容器可能是按序号取的、
      // 已经错位了；不退回的话，锚点会显示成 ✗（看起来像「荧光丢了」）。
      return search(container) ?? (container === root ? null : search(root))
    }
    //#endregion

    //#region store actions
    function addChip(anchor, kind) {
      const text = String(anchor?.quote || '').trim()
      if (text === '') return
      const existing = state.chips.find((chip) => chip.quote === text)
      if (existing !== undefined) {
        flash(existing.id)
        return
      }
      if (state.chips.length >= MAX_CHIPS) {
        flash(state.chips[state.chips.length - 1].id)
        return
      }
      state.chips.push({
        id: `c${(seq += 1)}`,
        kind: kind === 'point' ? 'point' : 'quote',
        quote: text,
        sent: false,
        scope: anchor?.scope ?? null,
        element: anchor?.block instanceof Element ? anchor.block : null,
        offsetIn: typeof anchor?.offsetIn === 'number' ? anchor.offsetIn : -1,
        offsetInRoot: typeof anchor?.offsetInRoot === 'number' ? anchor.offsetInRoot : -1,
        context: typeof anchor?.context === 'string' ? anchor.context : '',
        position: typeof anchor?.position === 'string' ? anchor.position : '',
        messageIndex: typeof anchor?.messageIndex === 'number' ? anchor.messageIndex : -1,
        messageId: typeof anchor?.messageId === 'string' ? anchor.messageId : '',
      })
      emit()
    }

    /** 消息发出去了：标记已发送，并给这次提问建一条记录。 */
    function markChipsSent() {
      let changed = false
      for (const chip of state.chips) {
        if (chip.sent !== true) {
          chip.sent = true
          changed = true
        }
      }
      const chip = state.chips[0]
      if (chip === undefined) {
        // 没带锚的提问也要打标记，用来截断「往前借用标签」的链条
        pendingQuestionId = NONE_TAG
      } else {
        const id = `q${(seq += 1)}`
        questionRecords.set(id, {
          id,
          quote: chip.quote,
          kind: chip.kind,
          offsetInRoot: chip.offsetInRoot,
          context: chip.context,
          position: chip.position,
          userIndex: -1,
          at: Date.now(),
        })
        pendingQuestionId = id
      }
      if (changed) emit()
    }

    /** 删除引用条：发过问的降级成浅色痕迹，没发过问的直接丢掉。 */
    function removeChip(id) {
      const index = state.chips.findIndex((chip) => chip.id === id)
      if (index < 0) return null
      if (state.chips[index].sent !== true) {
        state.chips.splice(index, 1)
        emit()
        return null
      }
      const [chip] = state.chips.splice(index, 1)
      state.asked.push({
        id: chip.id,
        kind: chip.kind,
        quote: chip.quote,
        sent: true,
        scope: chip.scope,
        element: chip.element ?? null,
        offsetIn: chip.offsetIn,
        offsetInRoot: chip.offsetInRoot,
        context: chip.context,
        position: chip.position,
        messageIndex: chip.messageIndex,
        messageId: chip.messageId,
      })
      emit()
      return chip
    }

    /** 把一条「问过」重新提回「正在问」。 */
    function promote(id) {
      const index = state.asked.findIndex((entry) => entry.id === id)
      if (index < 0) return null
      const [entry] = state.asked.splice(index, 1)
      const existing = state.chips.find((chip) => chip.quote === entry.quote)
      if (existing !== undefined) {
        emit()
        flash(existing.id)
        return existing
      }
      if (state.chips.length >= MAX_CHIPS) {
        state.asked.push(entry)
        emit()
        return null
      }
      const chip = {
        id: entry.id,
        kind: entry.kind,
        quote: entry.quote,
        sent: entry.sent === true,
        scope: entry.scope,
        element: entry.element ?? null,
        offsetIn: entry.offsetIn,
        offsetInRoot: entry.offsetInRoot,
        context: entry.context,
        position: entry.position,
        messageIndex: entry.messageIndex,
        messageId: entry.messageId,
      }
      state.chips.push(chip)
      emit()
      return chip
    }

    function setSession(sessionId) {
      const key = sessionId === undefined || sessionId === null ? '' : String(sessionId)
      if (key === activeKey) return
      if (activeKey === '' && state.chips.length > 0) {
        const target = bucketOf(key)
        target.chips.push(...state.chips)
        target.asked.push(...state.asked)
        buckets.set('', { chips: [], asked: [] })
      }
      activeKey = key
      state = hydrate(key)
      emit()
    }

    function toggleHidden() {
      hidden = !hidden
      try {
        window.localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0')
      } catch {
        /* 存不了也不影响显示开关 */
      }
      emit()
    }

    const store = { subscribe, getSnapshot, addChip, markChipsSent, removeChip, promote, setSession, toggleHidden }
    //#endregion

    //#region question records
    function userMessageNodes() {
      const root = document.querySelector(TRANSCRIPT)
      if (root === null) return []
      const nodes = []
      for (const slot of root.querySelectorAll(USER_TEXT)) {
        const message = slot.closest(CHAT_NODE)
        if (message !== null && !nodes.includes(message)) nodes.push(message)
      }
      return nodes
    }

    /** 把待标记的提问打到最新那条用户消息上。 */
    function tagPendingQuestion() {
      if (pendingQuestionId === null) return false
      const nodes = userMessageNodes()
      const last = nodes[nodes.length - 1]
      if (last === undefined || last.hasAttribute(Q_TAG)) return false
      const id = pendingQuestionId
      const record = questionRecords.get(id)
      // 刚发出去的头 100ms 里 DOM 可能还没插入新消息，等一等再贴
      if (record !== undefined && Date.now() - record.at < 100) return false
      if (record !== undefined) {
        record.userIndex = nodes.length - 1
        persist()
      }
      last.setAttribute(Q_TAG, id)
      pendingQuestionId = null
      return true
    }

    /** 刷新后按「第几条用户消息」重新贴标记。 */
    function retagQuestions() {
      const nodes = userMessageNodes()
      if (nodes.length === 0) return
      for (const [id, record] of questionRecords) {
        const node = record.userIndex >= 0 ? nodes[record.userIndex] : undefined
        if (node !== undefined && !node.hasAttribute(Q_TAG)) node.setAttribute(Q_TAG, id)
      }
    }

    let lastRetagAt = 0
    function retagQuestionsThrottled() {
      if (questionRecords.size === 0) return
      const now = Date.now()
      if (now - lastRetagAt < 500) return
      lastRetagAt = now
      retagQuestions()
    }

    /** 某条回答对应的提问：它前面最近的那条被标记的用户消息。 */
    function questionBefore(element) {
      const root = document.querySelector(TRANSCRIPT)
      if (root === null || element === null) return null
      let best = null
      for (const node of root.querySelectorAll(`[${Q_TAG}]`)) {
        if ((node.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) continue
        best = node
      }
      if (best === null) return null
      const record = questionRecords.get(best.getAttribute(Q_TAG))
      return record === undefined ? null : record
    }

    /** 某次提问对应的回答：被标记的用户消息之后的第一条 assistant 消息。 */
    function answerElementFor(record) {
      if (record === undefined || record === null) return null
      const nodes = userMessageNodes()
      const questionNode = record.userIndex >= 0 ? nodes[record.userIndex] : undefined
      if (questionNode === undefined) return null
      for (const node of document.querySelectorAll(CHAT_NODE)) {
        if ((questionNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) continue
        if (node.querySelector(USER_TEXT) !== null) continue
        return node
      }
      return null
    }

    function latestQuestionFor(entry) {
      if (entry === undefined || entry === null) return null
      let found = null
      for (const record of questionRecords.values()) {
        if (record.quote === entry.quote && record.offsetInRoot === entry.offsetInRoot) found = record
      }
      return found
    }
    //#endregion

    //#region overlays
    let flashRange = null
    let flashTimer = 0
    /** 由浮层组件挂上：矩形在跳转/闪烁后重新量一次。 */
    let refreshRects = null

    function elementOf(node) {
      if (node === null || node === undefined) return null
      return node.nodeType === 1 ? node : node.parentElement ?? null
    }

    function rectsOfRange(range) {
      const rects = []
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue
        rects.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height })
      }
      return rects
    }

    function rectsOf(root, entries) {
      const rects = []
      for (const entry of entries) {
        const range = locateEntry(root, entry)
        if (range === null) continue
        rects.push(...rectsOfRange(range))
      }
      return rects
    }

    /** 元素的可见矩形；包装层没有布局盒子时退到第一个有盒子的子元素。 */
    function visibleRect(element) {
      const own = element.getBoundingClientRect()
      if (own.width > 0 || own.height > 0) return own
      for (const child of element.querySelectorAll('*')) {
        const rect = child.getBoundingClientRect()
        if (rect.width > 0 || rect.height > 0) return rect
      }
      return null
    }

    function sameRects(left, right) {
      if (left.length !== right.length) return false
      for (let index = 0; index < left.length; index += 1) {
        if (
          left[index].x !== right[index].x ||
          left[index].y !== right[index].y ||
          left[index].w !== right[index].w ||
          left[index].h !== right[index].h
        ) {
          return false
        }
      }
      return true
    }

    function paintRect(rect, background, key) {
      return h('div', {
        key,
        style: {
          position: 'fixed',
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          background,
          borderRadius: 2,
          pointerEvents: 'none',
        },
      })
    }

    /**
     * 底色层：按 Range 的矩形画半透明块（不用 `::highlight()`，那条路坏起来没有声音）。
     * 顺序是「问过」在下、「正在问」在上、跳转闪烁最上。
     */
    function OverlayLayer() {
      const [rects, setRects] = React.useState({ asking: [], asked: [], flash: [] })

      React.useEffect(() => {
        let frame = 0
        const measure = () => {
          frame = 0
          try {
            if (pendingQuestionId !== null) tagPendingQuestion()
            retagQuestionsThrottled()
            const root = document.querySelector(TRANSCRIPT)
            const next =
              root === null
                ? { asking: [], asked: [], flash: [] }
                : {
                    asking: isHidden() ? [] : rectsOf(root, state.chips),
                    asked: isHidden() ? [] : rectsOf(root, state.asked),
                    // 隐藏只关常驻两层；跳转闪烁照旧要看得见
                    flash: flashRange === null ? [] : rectsOfRange(flashRange),
                  }
            setRects((current) =>
              sameRects(current.asking, next.asking) &&
              sameRects(current.asked, next.asked) &&
              sameRects(current.flash, next.flash)
                ? current
                : next,
            )
          } catch (error) {
            console.warn('[dsh-anchor] measure failed', error)
          }
        }
        const schedule = () => {
          if (frame !== 0) return
          frame = window.requestAnimationFrame(measure)
        }
        refreshRects = schedule
        const unsubscribe = store.subscribe(schedule)
        const observer = new MutationObserver(schedule)
        const root = document.querySelector(TRANSCRIPT)
        if (root !== null) observer.observe(root, { childList: true, subtree: true, characterData: true })
        window.addEventListener('scroll', schedule, true)
        window.addEventListener('resize', schedule)
        schedule()
        return () => {
          refreshRects = null
          unsubscribe()
          observer.disconnect()
          window.removeEventListener('scroll', schedule, true)
          window.removeEventListener('resize', schedule)
          if (frame !== 0) window.cancelAnimationFrame(frame)
        }
      }, [])

      return h(
        React.Fragment,
        null,
        ...rects.asked.map((rect, index) => paintRect(rect, 'rgba(255,183,43,0.16)', `asked-${index}`)),
        ...rects.asking.map((rect, index) => paintRect(rect, 'rgba(255,183,43,0.36)', `asking-${index}`)),
        ...rects.flash.map((rect, index) => paintRect(rect, 'rgba(255,140,0,0.52)', `flash-${index}`)),
      )
    }
    //#endregion

    //#region navigation
    function scrollElementIntoView(root, element) {
      const rect = visibleRect(element)
      if (rect === null) return false
      const box = root.getBoundingClientRect()
      const target = Math.max(0, root.scrollTop + (rect.top - box.top) - 24)
      root.scrollTop = target
      // 跟尾机制可能在同一帧把位置拉回去：稍后补一次
      window.setTimeout(() => {
        if (Math.abs(root.scrollTop - target) > 24) root.scrollTop = target
      }, 180)
      return true
    }

    /** 回到引用原文：滚到那句话并闪一下。 */
    function jumpToEntry(entry) {
      const root = document.querySelector(TRANSCRIPT)
      if (root === null) return false
      const range = locateEntry(root, entry)
      if (range === null) {
        flash(entry.id)
        return false
      }
      const rect = range.getBoundingClientRect()
      const box = root.getBoundingClientRect()
      const target = Math.max(0, root.scrollTop + (rect.top - box.top) - box.height / 3)
      root.scrollTop = target
      window.setTimeout(() => {
        if (Math.abs(root.scrollTop - target) > 24) root.scrollTop = target
      }, 180)
      flashRange = range
      if (refreshRects !== null) refreshRects()
      if (flashTimer !== 0) window.clearTimeout(flashTimer)
      flashTimer = window.setTimeout(() => {
        flashTimer = 0
        flashRange = null
        if (refreshRects !== null) refreshRects()
      }, 1600)
      return true
    }

    /** 去看这条锚对应的回答；推不出来（生成中 / 记录缺失）才退到最新处。 */
    function goToAnswer(entry) {
      const root = document.querySelector(TRANSCRIPT)
      if (root === null) return
      try {
        const element = answerElementFor(latestQuestionFor(entry))
        const scrolled = element !== null && root.contains(element) ? scrollElementIntoView(root, element) : false
        if (!scrolled) root.scrollTop = root.scrollHeight
      } catch (error) {
        console.warn('[dsh-anchor] jump failed', error)
      }
    }
    //#endregion

    //#region selection bar
    /** 这段选区是否落在已有的锚里；同一处重复框选会造出互相干扰的锚。 */
    function selectionOverlapsAnchor(root, range) {
      const { nodes } = collectText(root)
      const offsetAt = (node, offset) => {
        for (const entry of nodes) if (entry.node === node) return entry.start + offset
        return -1
      }
      const selStart = offsetAt(range.startContainer, range.startOffset)
      const selEnd = offsetAt(range.endContainer, range.endOffset)
      if (selStart < 0 || selEnd < 0 || selEnd <= selStart) return false
      for (const entry of [...state.chips, ...state.asked]) {
        const found = locateEntry(root, entry)
        if (found === null) continue
        const start = offsetAt(found.startContainer, found.startOffset)
        const end = offsetAt(found.endContainer, found.endOffset)
        if (start < 0 || end < 0) continue
        if (selStart < end && start < selEnd) return true
      }
      return false
    }

    function readSelection() {
      const selection = window.getSelection()
      if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null
      const text = selection.toString().trim()
      if (text === '') return null
      const anchorEl = elementOf(selection.anchorNode)
      const focusEl = elementOf(selection.focusNode) ?? anchorEl
      if (anchorEl === null) return null
      const scope = anchorEl.closest(TRANSCRIPT)
      if (scope === null) return null
      // 不允许跨消息
      const anchorNode = anchorEl.closest(CHAT_NODE)
      const focusNode = focusEl === null ? null : focusEl.closest(CHAT_NODE)
      if (anchorNode !== null && focusNode !== null && anchorNode !== focusNode) return null
      const range = selection.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return null
      if (selectionOverlapsAnchor(scope, range)) return null
      const scopeEl = messageScopeOf(anchorEl, scope)
      return {
        text,
        rect,
        scope: scopeEl,
        offsetIn: textOffsetOf(scopeEl, range.startContainer, range.startOffset),
        offsetInRoot: textOffsetOf(scope, range.startContainer, range.startOffset),
        context: blockTextOf(anchorEl),
        position: describePosition(range.startContainer, scopeEl, scope),
        messageIndex: messageIndexOf(scopeEl),
        messageId: messageIdOf(scopeEl),
        block: blockOf(anchorEl),
      }
    }

    function SelectionBar() {
      const [bar, setBar] = React.useState(null)
      const barRef = React.useRef(null)

      React.useEffect(() => {
        let timer = null
        const clearTimer = () => {
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
        }
        const hide = () => setBar(null)

        const onMouseUp = (event) => {
          if (event.button !== 0) return
          const target = event.target
          if (barRef.current !== null && target instanceof Node && barRef.current.contains(target)) return
          clearTimer()
          timer = setTimeout(() => {
            timer = null
            setBar(readSelection())
          }, SELECT_DELAY)
        }
        const onMouseDown = (event) => {
          const target = event.target
          if (barRef.current !== null && target instanceof Node && barRef.current.contains(target)) return
          clearTimer()
          hide()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') hide()
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') hide()
        }
        const onScroll = () => hide()
        const onContextMenu = () => hide()

        document.addEventListener('mouseup', onMouseUp, true)
        document.addEventListener('mousedown', onMouseDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('contextmenu', onContextMenu, true)
        window.addEventListener('scroll', onScroll, true)
        return () => {
          clearTimer()
          document.removeEventListener('mouseup', onMouseUp, true)
          document.removeEventListener('mousedown', onMouseDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          document.removeEventListener('contextmenu', onContextMenu, true)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [])

      if (bar === null) return null

      const { rect, text } = bar
      const below = rect.top < 56
      const style = {
        position: 'fixed',
        zIndex: 2147483001,
        top: below ? rect.bottom + 8 : rect.top - 40,
        left: Math.max(8, Math.min(window.innerWidth - 168, rect.left + rect.width / 2 - 80)),
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: 3,
        borderRadius: 10,
        border: '1px solid rgba(127,127,127,0.32)',
        background: 'var(--dsw-alias-bg-base, #fff)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.22)',
        pointerEvents: 'auto',
      }
      const buttonStyle = {
        border: 0,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '24px',
        padding: '0 10px',
        borderRadius: 7,
        cursor: 'pointer',
      }
      const act = (fn) => (event) => {
        event.preventDefault()
        event.stopPropagation()
        fn()
        setBar(null)
        window.getSelection()?.removeAllRanges()
      }

      return h(
        'div',
        { ref: barRef, style, [UI_ATTR]: 'bar', onMouseDown: (event) => event.preventDefault() },
        h(
          'button',
          {
            type: 'button',
            style: buttonStyle,
            onClick: act(() =>
              store.addChip({
                quote: text,
                scope: bar.scope,
                block: bar.block,
                offsetIn: bar.offsetIn,
                offsetInRoot: bar.offsetInRoot,
                context: bar.context,
                position: bar.position,
                messageIndex: bar.messageIndex,
                messageId: bar.messageId,
              }),
            ),
          },
          '提问',
        ),
        h('div', { style: { width: 1, height: 14, background: 'rgba(127,127,127,0.3)' } }),
        h(
          'button',
          {
            type: 'button',
            style: buttonStyle,
            onClick: act(() => {
              void navigator.clipboard?.writeText(text)
            }),
          },
          '复制',
        ),
      )
    }
    //#endregion

    //#region point anchor
    /** 不选字时，用视口里光标所在的那一段当锚点。 */
    function capturePointAnchor() {
      const root = document.querySelector(TRANSCRIPT)
      if (root === null) return null
      const box = root.getBoundingClientRect()
      const x = box.left + box.width / 2
      const y = box.top + Math.min(Math.max(box.height * 0.45, 80), Math.max(box.height - 80, 80))
      if (typeof document.caretRangeFromPoint !== 'function') return null
      const caret = document.caretRangeFromPoint(x, y)
      if (caret === null) return null
      const element = elementOf(caret.startContainer)
      if (element === null || element.closest(TRANSCRIPT) === null) return null
      const block = blockOf(element)
      const text = (block.textContent || '').replace(/\s+/g, ' ').trim()
      if (text === '') return null
      const scopeEl = messageScopeOf(block, root)
      return {
        quote: text.slice(0, 80),
        scope: scopeEl,
        block,
        offsetIn: textOffsetOf(scopeEl, block, 0),
        offsetInRoot: textOffsetOf(root, block, 0),
        context: text.slice(0, 400),
        position: describePosition(block, scopeEl, root),
        messageIndex: messageIndexOf(scopeEl),
        messageId: messageIdOf(scopeEl),
      }
    }
    //#endregion

    //#region icons
    function lineIcon(children, size) {
      const px = typeof size === 'number' ? size : 16
      return h(
        'svg',
        {
          width: px,
          height: px,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        ...children,
      )
    }

    function PinIcon({ size }) {
      return lineIcon(
        [
          h('path', { key: 'pin', d: 'M12 21s6.5-5.9 6.5-11a6.5 6.5 0 1 0-13 0C5.5 15.1 12 21 12 21z' }),
          h('circle', { key: 'dot', cx: 12, cy: 10, r: 2.2 }),
        ],
        size,
      )
    }

    function EyeIcon({ off, size }) {
      const children = [
        h('path', { key: 'eye', d: 'M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z' }),
        h('circle', { key: 'pupil', cx: 12, cy: 12, r: 3 }),
      ]
      if (off) children.push(h('path', { key: 'slash', d: 'M4.2 19.8 19.8 4.2' }))
      return lineIcon(children, size)
    }

    function ChevronDownIcon({ size }) {
      return lineIcon([h('path', { key: 'chevron', d: 'M6 9.5 12 15l6-5.5' })], size)
    }

    function CloseIcon({ size }) {
      return lineIcon([h('path', { key: 'cross', d: 'M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5' })], size)
    }
    //#endregion

    //#region composer tool row
    function chipStyle(active) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        maxWidth: 210,
        height: 24,
        padding: '0 2px 0 6px',
        borderRadius: 8,
        border: '1px solid rgba(255,183,43,0.45)',
        background: active ? 'rgba(255,183,43,0.18)' : 'rgba(255,183,43,0.08)',
        fontSize: 12,
        lineHeight: '20px',
      }
    }

    function pushAnchorToHost(sessionId, chip) {
      void fetch('/dsh-anchor/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: String(sessionId ?? ''),
          kind: chip.kind,
          quote: chip.quote,
          context: chip.context ?? '',
          position: chip.position ?? '',
        }),
      }).catch((error) => {
        console.warn('[dsh-anchor] host sync failed', error)
      })
    }

    function clearAnchorOnHost(sessionId) {
      void fetch('/dsh-anchor/clear', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: String(sessionId ?? '') }),
      }).catch((error) => {
        console.warn('[dsh-anchor] host clear failed', error)
      })
    }

    function DockBody() {
      const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const [flashing, setFlashing] = React.useState(null)
      const [hover, setHover] = React.useState('')

      React.useEffect(() => {
        const listener = (id) => {
          setFlashing(id)
          window.setTimeout(() => setFlashing((current) => (current === id ? null : current)), 600)
        }
        flashListeners.add(listener)
        return () => {
          flashListeners.delete(listener)
        }
      }, [])

      const iconStyle = (id, dim) => ({
        width: 26,
        height: 26,
        display: 'grid',
        placeItems: 'center',
        border: 0,
        borderRadius: 7,
        background: hover === id ? 'rgba(127,127,127,0.14)' : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        padding: 0,
        opacity: dim ? 0.45 : 0.72,
        transition: 'background 120ms ease, opacity 120ms ease',
      })

      const iconButton = (id, title, icon, onClick, dim) =>
        h(
          'button',
          {
            type: 'button',
            title,
            style: iconStyle(id, dim),
            onMouseEnter: () => setHover(id),
            onMouseLeave: () => setHover((current) => (current === id ? '' : current)),
            onClick,
          },
          icon,
        )

      const glyph = {
        border: 0,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        display: 'grid',
        placeItems: 'center',
        padding: 0,
        opacity: 0.62,
      }

      return h(
        'div',
        {
          [UI_ATTR]: 'tools',
          style: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden' },
        },
        // 两个固定按钮在最左边：chip 出现或消失时它们不会左右跳
        iconButton(
          'pin',
          '不选字，就按当前读到的地方问',
          h(PinIcon, { size: 16 }),
          () => {
            const anchor = capturePointAnchor()
            if (anchor !== null) addChip(anchor, 'point')
          },
          false,
        ),
        iconButton(
          'eye',
          snap.hidden ? '显示荧光区域' : '隐藏荧光区域（方便截屏，不删数据）',
          h(EyeIcon, { off: snap.hidden, size: 16 }),
          () => store.toggleHidden(),
          snap.hidden,
        ),
        ...snap.chips.map((chip) =>
          h(
            'span',
            {
              key: chip.id,
              style: {
                ...chipStyle(flashing === chip.id),
                outline: flashing === chip.id ? '2px solid rgba(255,183,43,0.55)' : 'none',
                transition: 'outline 120ms ease, background 120ms ease',
              },
            },
            h(PinIcon, { size: 13 }),
            h(
              'button',
              {
                type: 'button',
                style: {
                  border: 0,
                  background: 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                  cursor: 'pointer',
                  padding: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 116,
                },
                title: `${chip.quote}\n点击回到原文`,
                onClick: () => jumpToEntry(chip),
              },
              chip.kind === 'point' ? '这里' : chip.quote,
            ),
            h(
              'button',
              {
                type: 'button',
                title: '看答案',
                style: { ...glyph, width: 20, height: 20 },
                onClick: () => goToAnswer(chip),
              },
              h(ChevronDownIcon, { size: 13 }),
            ),
            h(
              'button',
              {
                type: 'button',
                title: '结束这处追问',
                style: { ...glyph, width: 20, height: 20 },
                onClick: () => removeChip(chip.id),
              },
              h(CloseIcon, { size: 13 }),
            ),
          ),
        ),
      )
    }

    /** 不在这一层调 hook：`useInput` 是否存在决定下面挂哪个组件。 */
    function AnchorDock(props) {
      if (typeof props?.useInput !== 'function' || props?.inputActions === undefined) return h(DockBody)
      return h(DockLive, props)
    }

    function DockLive(props) {
      const input = props.useInput((value) => value)
      const lastDraft = React.useRef('')

      React.useEffect(() => {
        setSession(props.sessionId)
      }, [props.sessionId])

      // 提交阶段或草稿清空 = 这一轮发出去了
      React.useEffect(() => {
        const phase = input?.phase
        const current = typeof input?.draft === 'string' ? input.draft : ''
        if (phase === 'submitting') markChipsSent()
        else if (lastDraft.current.trim() !== '' && current === '') markChipsSent()
        lastDraft.current = current
      }, [input])

      // 锚点变化 -> 报给宿主；宿主是提示词的唯一入口
      React.useEffect(() => {
        const sync = () => {
          const chip = store.getSnapshot().chips[0]
          if (chip === undefined) clearAnchorOnHost(props.sessionId)
          else pushAnchorToHost(props.sessionId, chip)
        }
        sync()
        return store.subscribe(sync)
      }, [props.sessionId])

      return h(DockBody)
    }
    //#endregion

    //#region highlight menu
    /** 点某处荧光时，列出这处**问过**的锚。未发送的不出菜单，直接在 chip 上叉掉。 */
    function entriesAtPoint(clientX, clientY) {
      const root = document.querySelector(TRANSCRIPT)
      if (root === null || typeof document.caretRangeFromPoint !== 'function') return []
      const caret = document.caretRangeFromPoint(clientX, clientY)
      if (caret === null) return []
      const node = caret.startContainer
      const offset = caret.startOffset
      if (elementOf(node)?.closest(TRANSCRIPT) === null) return []

      const candidates = []
      const consider = (entry, asking) => {
        if (entry.sent !== true) return
        const range = locateEntry(root, entry)
        if (range === null || !range.isPointInRange(node, offset)) return
        candidates.push({
          id: entry.id,
          quote: entry.quote,
          asking,
          entry,
          length: range.toString().length,
        })
      }
      for (const chip of state.chips) consider(chip, true)
      for (const entry of state.asked) consider(entry, false)

      candidates.sort((left, right) => left.length - right.length)
      const seen = new Set()
      const hits = []
      for (const hit of candidates) {
        if (seen.has(hit.quote)) continue
        seen.add(hit.quote)
        hits.push(hit)
      }
      return hits
    }

    function HighlightMenu() {
      const [menu, setMenu] = React.useState(null)
      const menuRef = React.useRef(null)

      React.useEffect(() => {
        const onClick = (event) => {
          const target = event.target
          if (menuRef.current !== null && target instanceof Node && menuRef.current.contains(target)) return
          if (elementOf(target)?.closest(`[${UI_ATTR}]`) !== null) return
          const hits = entriesAtPoint(event.clientX, event.clientY)
          if (hits.length === 0) {
            setMenu(null)
            return
          }
          setMenu({ x: event.clientX, y: event.clientY, hits })
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setMenu(null)
        }
        const onScroll = () => setMenu(null)
        document.addEventListener('click', onClick, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('scroll', onScroll, true)
        return () => {
          document.removeEventListener('click', onClick, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [])

      if (menu === null) return null

      const width = 288
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, menu.x - 40))
      const top = Math.min(window.innerHeight - 40, menu.y + 14)

      return h(
        'div',
        {
          ref: menuRef,
          [UI_ATTR]: 'menu',
          style: {
            position: 'fixed',
            zIndex: 2147483002,
            left,
            top,
            width,
            padding: 6,
            borderRadius: 10,
            border: '1px solid rgba(127,127,127,0.32)',
            background: 'var(--dsw-alias-bg-base, #fff)',
            color: 'inherit',
            boxShadow: '0 8px 28px rgba(0,0,0,0.24)',
            pointerEvents: 'auto',
            fontSize: 12,
          },
        },
        ...menu.hits.map((hit) =>
          h(
            'div',
            {
              key: hit.id,
              style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 7 },
            },
            h('span', { style: { opacity: 0.7 } }, hit.asking ? '📍' : '·'),
            h(
              'span',
              {
                style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                title: hit.quote,
              },
              hit.quote,
            ),
            h(
              'button',
              {
                type: 'button',
                title: hit.asking ? '看答案' : '再问一次：重新挂成引用条，并去看对应回答',
                style: {
                  border: 0,
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  padding: '0 4px',
                  fontSize: 11,
                  opacity: 0.8,
                  whiteSpace: 'nowrap',
                },
                onClick: () => {
                  if (!hit.asking) store.promote(hit.id)
                  goToAnswer(hit.entry)
                  setMenu(null)
                },
              },
              '看答案 ↓',
            ),
          ),
        ),
      )
    }
    //#endregion

    //#region answer label
    /**
     * 挂在回答动作行上的来源标签。
     *
     * 不靠「谁先抢到认领」：只看文档顺序——这条回答前面最近的那条被标记过的
     * 用户消息，就是它对应的提问。顺带把消息 id 写到容器上，锚点就有了稳定身份。
     */
    function AnswerLabel({ messageId }) {
      const ref = React.useRef(null)
      const [label, setLabel] = React.useState(null)

      React.useEffect(() => {
        const element = ref.current === null ? null : ref.current.closest(CHAT_NODE)
        if (element === null) return undefined
        if (messageId !== undefined && messageId !== null) element.setAttribute(MID_ATTR, String(messageId))
        const update = () => {
          const record = questionBefore(element)
          if (record !== null) setLabel((current) => current ?? record)
        }
        update()
        const timer = window.setTimeout(update, 400)
        return () => window.clearTimeout(timer)
      }, [messageId])

      if (label === null) {
        return h('span', { ref, style: { display: 'none' }, 'aria-hidden': 'true' })
      }

      const text =
        label.kind === 'point' ? '这里' : label.quote.length > 24 ? `${label.quote.slice(0, 24)}…` : label.quote

      return h(
        'button',
        {
          type: 'button',
          ref,
          title: `${label.position === '' ? '' : `${label.position}\n`}${label.quote}\n点击回到原文`,
          onClick: () => jumpToEntry(label),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            maxWidth: 300,
            border: 0,
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontSize: 12,
            lineHeight: '20px',
            padding: '0 4px',
            cursor: 'pointer',
            opacity: 0.72,
          },
        },
        h(PinIcon, { size: 13 }),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, text),
      )
    }
    //#endregion

    //#region debug panel
    /** 存档状态：会话键、键是否存在、长度；排查「重启后丢了」用。 */
    function storageReport() {
      const key = `${STORAGE_PREFIX}${activeKey}`
      const label = activeKey === '' ? '(会话未知)' : activeKey.slice(-8)
      try {
        const raw = window.localStorage.getItem(key)
        return raw === null ? `无（键 …${label}）` : `有 ${raw.length} 字符（键 …${label}）`
      } catch {
        return '读不到 localStorage'
      }
    }

    /**
     * 隐藏的调试面板：**Ctrl/⌘ + Alt + D** 打开或关闭。
     *
     * 平时完全不渲染，不占界面。打开后显示宿主这一轮实际注入的提示词，以及
     * 本地定位状态——出问题时先看这里，比猜快得多。
     */
    function DebugPanel() {
      const [open, setOpen] = React.useState(false)
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'd') {
            event.preventDefault()
            setOpen((value) => !value)
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        let alive = true
        const load = () => {
          fetch('/dsh-anchor/debug')
            .then((response) => response.json())
            .then((payload) => {
              if (!alive) return
              setData(payload)
              setError('')
            })
            .catch((failure) => {
              if (!alive) return
              setError(String(failure))
            })
        }
        load()
        const timer = window.setInterval(load, 1500)
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [open])

      if (!open) return null

      const rendered = data === null || typeof data.rendered !== 'string' ? '' : data.rendered
      const sessions = data === null ? 0 : data.sessions ?? 0
      const root = document.querySelector(TRANSCRIPT)
      const located = [...state.chips, ...state.asked]
        .map((entry) => `${root !== null && locateEntry(root, entry) !== null ? '✓' : '✗'}${String(entry.quote).slice(0, 6)}`)
        .join(' ')

      return h(
        'div',
        {
          [UI_ATTR]: 'debug',
          style: {
            position: 'fixed',
            left: 12,
            bottom: 12,
            width: 460,
            maxHeight: '48vh',
            overflow: 'auto',
            padding: '8px 10px',
            borderRadius: 10,
            border: '1px solid rgba(127,127,127,0.35)',
            background: 'var(--dsw-alias-bg-base, #fff)',
            color: 'inherit',
            boxShadow: '0 8px 28px rgba(0,0,0,0.24)',
            pointerEvents: 'auto',
            fontSize: 11,
            lineHeight: 1.5,
            zIndex: 2147483003,
          },
        },
        h('div', { style: { fontWeight: 600, marginBottom: 4 } }, `dsh-anchor 调试 · 会话 ${sessions} · Ctrl+Alt+D 关闭`),
        h(
          'div',
          {
            style: {
              marginBottom: 6,
              padding: '4px 6px',
              borderRadius: 6,
              background: 'rgba(127,127,127,0.10)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 10,
              whiteSpace: 'pre-wrap',
            },
          },
          `锚 ${state.chips.length} 条 · 痕迹 ${state.asked.length} 条 · 提问记录 ${questionRecords.size} 条 · 已贴标记 ${document.querySelectorAll(`[${Q_TAG}]`).length} 个\n` +
            `存档 ${storageReport()}\n` +
            `定位 ${located === '' ? '（暂无锚点）' : located}`,
        ),
        error !== '' ? h('div', { style: { color: '#c0392b' } }, error) : null,
        h(
          'pre',
          {
            style: {
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 11,
            },
          },
          rendered === '' ? '（宿主那边还没有锚点，这一轮不会注入任何内容）' : rendered,
        ),
      )
    }
    //#endregion

    //#region error boundary
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.warn('[dsh-anchor] component failed', error)
      }

      render() {
        return this.state.failed ? null : this.props.children
      }
    }
    //#endregion

    /** 注册入口。整段包住：插件自己的问题不该把整个界面带走。 */
    function apply(ctx) {
      try {
        ctx.slots.inject(SLOT_OVERLAY, () =>
          ctx.slots.register({ name: SLOT_OVERLAY, id: 'dsh-anchor-bar', label: () => 'dsh-anchor' }, () =>
            h(Boundary, null, h(OverlayLayer), h(SelectionBar), h(HighlightMenu), h(DebugPanel)),
          ),
        )
        ctx.slots.inject(SLOT_TOOLS, () =>
          ctx.slots.register({ name: SLOT_TOOLS, id: 'dsh-anchor-tools', order: 100 }, (props) =>
            h(Boundary, null, h(AnchorDock, props)),
          ),
        )
        ctx.slots.inject(SLOT_ANSWER, () =>
          ctx.slots.register({ name: SLOT_ANSWER, id: 'dsh-anchor-answer', order: 80 }, (props) =>
            h(Boundary, null, h(AnswerLabel, { messageId: props === undefined ? undefined : props.messageId })),
          ),
        )
      } catch (error) {
        console.warn('[dsh-anchor] apply failed', error)
      }
    }

    exports.name = 'dsh-anchor'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})

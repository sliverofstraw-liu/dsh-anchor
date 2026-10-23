/**
 * Loader-shape smoke test for the client bundle.
 *
 * Runs the bundle in a VM with a stubbed `window.__ModuleLoader__` and a stubbed
 * `require`, then asserts the exports and that `apply` registers each slot it
 * promises. Components are not invoked: they call hooks, which need a renderer.
 */
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const source = fs.readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

const registrations = []
const window = {
  __ModuleLoader__: {
    load(spec) {
      registrations.push(spec)
    },
  },
}

class Component {
  constructor(props) {
    this.props = props
    this.state = {}
  }

  setState(next) {
    this.state = { ...this.state, ...next }
  }
}

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  Component,
  Fragment: 'Fragment',
}

const requireFn = (name) => {
  if (name === 'react') return React
  throw new Error(`smoke: unexpected require("${name}") — the module table does not provide it`)
}

const sandbox = {
  window,
  console,
  require: requireFn,
  Symbol,
  Object,
  Error,
  Map,
  Set,
  JSON,
  Math,
  Date,
  Array,
  String,
  Number,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client/client.js' })

assert.equal(registrations.length, 1, 'bundle must call __ModuleLoader__.load exactly once')
const [{ id, factory }] = registrations
assert.equal(id, 'dsh-anchor', 'bundle id must be the package name the loader dispatches on')
assert.equal(typeof factory, 'function', 'factory must be a function')

const mod = factory(requireFn)
assert.equal(mod.name, 'dsh-anchor')
assert.deepEqual([...mod.inject], ['slots'])
assert.equal(typeof mod.apply, 'function')

const entries = []
const ctx = {
  slots: {
    inject(_name, callback) {
      callback()
    },
    register(meta, component) {
      entries.push({ meta, component })
      return () => {}
    },
  },
}
mod.apply(ctx)

assert.equal(entries.length, 3, 'apply must register every slot')
const bySlot = new Map(entries.map((entry) => [entry.meta.name, entry]))
assert.ok(bySlot.has('shell.overlay'), 'missing the selection bar entry')
assert.ok(bySlot.has('conversation.input.left'), 'missing the composer tool row entry')
assert.ok(bySlot.has('conversation.chat.assistant-actions'), 'missing the answer label entry')
for (const entry of entries) {
  assert.equal(typeof entry.component, 'function', `${entry.meta.name} must render`)
  assert.equal(typeof entry.meta.id, 'string')
}

console.log('smoke ok:', entries.map((entry) => entry.meta.name).join(' + '))

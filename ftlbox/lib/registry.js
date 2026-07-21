'use strict'
// FTLBOX runs as a plain CLI: every command is a fresh, short-lived process.
// Pear/Hyperdrive itself doesn't care about "names" - it only knows public
// keys and the corestore folder that holds the actual hypercore data.
// This tiny registry file (ftlbox.json, in the current working directory)
// is OUR bookkeeping layer on top of that, so a human can type
// `ftlbox seed alice-drive` instead of a 64-char hex key every time.
const fs = require('fs')
const path = require('path')

const REGISTRY_PATH = path.join(process.cwd(), 'ftlbox.json')
const DATA_ROOT = path.join(process.cwd(), 'ftlbox-data')

function load () {
  if (!fs.existsSync(REGISTRY_PATH)) return { drives: {} }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'))
}

function save (reg) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2))
}

function get (name) {
  const reg = load()
  return reg.drives[name]
}

function upsert (name, patch) {
  const reg = load()
  reg.drives[name] = { ...(reg.drives[name] || {}), ...patch }
  save(reg)
  return reg.drives[name]
}

function all () {
  return load().drives
}

// Used by "unregister": forgets the name -> key/path mapping. Does NOT
// touch anything on disk (storage folder, pulled directory) - it only
// removes our bookkeeping entry, same as `git remote remove` doesn't delete
// any files, just the remote reference.
function remove (name) {
  const reg = load()
  const existed = Object.prototype.hasOwnProperty.call(reg.drives, name)
  delete reg.drives[name]
  save(reg)
  return existed
}

// Every drive (own or a remote replica) gets its own corestore folder.
// Corestore persists hypercore data + keypairs to disk here, which is what
// lets a writable drive keep the SAME public key every time we reopen it.
function storagePathFor (name) {
  return path.join(DATA_ROOT, name)
}

module.exports = { get, upsert, all, remove, storagePathFor, REGISTRY_PATH, DATA_ROOT }

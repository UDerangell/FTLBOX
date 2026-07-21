'use strict'
// ---------------------------------------------------------------------------
// This module is the only place that talks to the Pear/Holepunch stack:
//
//   corestore   - manages the raw append-only logs ("hypercores") on disk
//                 that everything else is built on top of.
//   hyperdrive  - a filesystem-like data structure (files + folders) stored
//                 as a hypercore. It gives us .put()/.get()/.list()/.diff()
//                 and, crucially, versioning: every write is a new version.
//   hyperswarm  - peer-to-peer networking. swarm.join(topic) announces the
//                 topic on the Kademlia DHT (Distributed Hash Table) and/or
//                 looks up other peers announcing that same topic, then
//                 opens direct encrypted connections to them.
//   localdrive  - wraps an ordinary local folder so it exposes the SAME
//                 interface as a hyperdrive. That means we can "mirror"
//                 local-folder <-> hyperdrive in either direction with the
//                 exact same call.
//
// Every drive a user knows about, own or remote, lives in the registry
// under a short name (see lib/registry.js). As of v0.02, a remote drive's
// name -> public key mapping must be created explicitly with register()
// before ls/versions/pull can use that name - there is no more "pass a key
// and a name together" shortcut. This removes any ambiguity in command
// arguments about whether something typed on the command line is a name or
// a raw public key: after registration, it's always a name.
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const Localdrive = require('localdrive')
const b4a = require('b4a')
const registry = require('./registry')

// A drive is considered to have this as its lowest possible version: an
// empty, just-created drive (before any put()) reports version 1, confirmed
// directly against the installed hyperdrive package. There is no version 0
// with actual content, so validation and range-listing both use this as the
// floor.
const BASELINE_VERSION = 1

// -- small formatting helpers ------------------------------------------------

// Turns a sorted (or unsorted) list of version numbers into a compact
// string like "1-3, 5, 7-9". Runs of consecutive integers collapse to a
// single "start-end" segment; isolated numbers stand alone. Under today's
// hypercore semantics a whole-drive version list is always one contiguous
// run (hypercore's append-only counter never skips a number), so in
// practice this will usually render as a single range - but the function
// itself is general-purpose so it also works if it's ever pointed at a
// genuinely sparse list (e.g. a future "versions where this one file
// changed" feature, which would be sparse by nature).
function compressRanges (nums) {
  if (!nums.length) return '(none)'
  const sorted = [...new Set(nums)].sort((a, b) => a - b)
  const parts = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i]
    if (n === prev + 1) { prev = n; continue }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`)
    start = n
    prev = n
  }
  parts.push(start === prev ? `${start}` : `${start}-${prev}`)
  return parts.join(', ')
}

function formatBytes (n) {
  if (n == null) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function isValidKeyHex (s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s)
}

// -- core open/close/replicate helpers ---------------------------------------

// A drive's public key is what you hand to another person so they can find
// and replicate your data over the DHT. We store/print it as hex.
function keyToHex (key) { return b4a.toString(key, 'hex') }
function hexToKey (hex) { return b4a.from(hex, 'hex') }

// Open (or create) a Hyperdrive backed by a Corestore rooted at `storageDir`.
// - If `remoteKeyHex` is omitted: Hyperdrive(store) with no key makes/reuses
//   OUR OWN writable drive. Corestore persists the keypair in storageDir, so
//   calling this again later against the same folder reopens the identical
//   drive with the identical public key.
// - If `remoteKeyHex` is given: Hyperdrive(store, key) opens a (read-only,
//   to us) replica of someone else's drive, identified by their public key.
async function openDrive (storageDir, remoteKeyHex) {
  const store = new Corestore(storageDir)
  const drive = remoteKeyHex
    ? new Hyperdrive(store, hexToKey(remoteKeyHex))
    : new Hyperdrive(store)
  await drive.ready()
  return { store, drive }
}

// Closing just the Hyperdrive is not enough - the Corestore it sits on top
// of holds its own file handles/locks open on storageDir. Since each CLI
// command is a short-lived process that opens the store fresh, we always
// close both, otherwise a later command touching the same storageDir in the
// same process (or, on some platforms, even a subsequent process) can fail
// with a "File descriptor could not be locked" error.
async function closeDrive ({ store, drive }) {
  await drive.close()
  await store.close()
}

// Join the DHT for a drive's discovery key and wire up replication.
// discoveryKey is a hash derived from the drive's public key - it's what
// actually gets announced on the DHT, so peers can find each other without
// exposing the real public key to random DHT nodes.
// mode: { server: true }  -> announce ourselves as a source of this data (seeding)
//       { client: true }  -> look up peers who are announcing it (pulling)
async function joinSwarm (store, drive, { server, client }) {
  const swarm = new Hyperswarm()
  // Whenever hyperswarm hands us a new peer connection, replicate our
  // corestore over it. Replication is what actually streams hypercore
  // blocks (file data + the drive's internal index) between peers.
  swarm.on('connection', (conn) => store.replicate(conn))
  const discoveryDone = drive.findingPeers()
  swarm.join(drive.discoveryKey, { server: !!server, client: !!client })
  await swarm.flush() // resolves once our announce/lookup round has gone out
  discoveryDone()
  return swarm
}

// Opens a drive by registry name, and if it's a remote drive, connects to
// the DHT as a client and asks it to fetch whatever's newest from reachable
// peers. Returns everything ls/versions/pull need: the open handles, the
// swarm (null for own drives - no networking needed, they're always fully
// up to date locally), and the version we could actually confirm live.
// This is the one place "how do I get an up-to-date view of a registered
// drive" is implemented, so ls/versions/pull can't drift out of sync with
// each other on that logic.
async function openAndSync (entry) {
  const isRemote = entry.role === 'remote'
  const opened = await openDrive(entry.storageDir, isRemote ? entry.key : undefined)
  let swarm = null
  if (isRemote) {
    // Called via module.exports (not the bare local function) so that
    // test/full-flow.js can substitute an in-memory replication stand-in
    // for the real DHT/Hyperswarm connection - every other line of
    // register/versions/ls/pull/diff runs completely unmodified either way.
    swarm = await module.exports.joinSwarm(opened.store, opened.drive, { client: true })
    await opened.drive.update({ wait: true }).catch(() => {}) // no-op if nobody's reachable right now
  }
  return { ...opened, swarm, isRemote, liveVersion: opened.drive.version }
}

async function closeAndDisconnect ({ store, drive, swarm }) {
  if (swarm) await swarm.destroy()
  await closeDrive({ store, drive })
}

function requireOwn (name) {
  const entry = registry.get(name)
  if (!entry || entry.role !== 'own') throw new Error(`"${name}" is not one of your own writable drives. Run "create" first.`)
  return entry
}

// Every ls/versions/pull call starts here. Unlike requireOwn, this accepts
// either role: an "own" drive (created with `create`) or a "remote" one
// (registered with `register`) - both are things you can inspect and pull.
function requireRegistered (name) {
  const entry = registry.get(name)
  if (!entry) throw new Error(`Unknown drive "${name}". Register it first: ftlbox register ${name} <publicKeyHex>  (or "ftlbox create ${name}" if this is meant to be your own new drive)`)
  return entry
}

// -- public operations --------------------------------------------------

// Use case: "Alice/Bob creates a new hyperdrive and gets a public key"
async function create (name) {
  const existing = registry.get(name)
  if (existing && existing.role === 'remote') {
    throw new Error(`"${name}" is already registered as someone else's drive. Choose a different name, or "unregister ${name}" first.`)
  }
  const storageDir = registry.storagePathFor(name)
  const opened = await openDrive(storageDir)
  const keyHex = keyToHex(opened.drive.key)
  registry.upsert(name, { role: 'own', storageDir, key: keyHex })
  await closeDrive(opened)
  return keyHex
}

// Records a name -> public key mapping for a drive you don't own, WITHOUT
// touching the network or creating any hypercore data yet - it's pure local
// bookkeeping, same idea as `git remote add <name> <url>`. After this,
// ls/versions/pull can all be called with just the name.
//
// Decisions made here (see conversation for the reasoning):
//   - the key's hex format is validated immediately (64 hex chars), so a
//     typo is caught right away instead of surfacing later as a confusing
//     network error.
//   - re-registering the same name to the SAME key is a harmless no-op.
//   - re-registering an existing name to a DIFFERENT key requires
//     `--force`, to stop an accidental overwrite of a name you're already
//     using (mirrors `git remote add` refusing to reuse a name silently).
//   - a name that belongs to one of your OWN drives (via `create`) can
//     never be reused for register, forced or not - that would blur the
//     "own vs. remote" distinction that pull/seed/add rely on.
async function register (name, keyHex, opts = {}) {
  if (!isValidKeyHex(keyHex)) throw new Error('Invalid public key: expected exactly 64 hex characters.')
  const normalizedKey = keyHex.toLowerCase()
  const existing = registry.get(name)
  if (existing) {
    if (existing.role === 'own') {
      throw new Error(`"${name}" is already the name of one of your own drives (made with "create"). Choose a different name.`)
    }
    if (existing.key === normalizedKey) {
      return existing // already registered to this exact key - nothing to do
    }
    if (!opts.force) {
      throw new Error(`"${name}" is already registered to a different key. Re-run with --force to overwrite, or pick a different name.`)
    }
  }
  const storageDir = (existing && existing.storageDir) || registry.storagePathFor(name)
  return registry.upsert(name, { role: 'remote', key: normalizedKey, storageDir })
}

// Forgets a name -> key mapping. Deliberately local-bookkeeping-only: any
// data already pulled to disk (storageDir, pullDir) is left untouched, same
// as `git remote remove` doesn't delete anything you'd already fetched.
async function unregister (name) {
  const entry = registry.get(name)
  if (!entry) throw new Error(`"${name}" is not registered.`)
  if (entry.role === 'own') throw new Error(`"${name}" is one of your own drives, not a registered remote one - "unregister" doesn't apply to it.`)
  registry.remove(name)
  return entry
}

// Use case: "Alice/Bob adds the contents of a specified directory to her/his
// hyperdrive". We wrap the local folder in a Localdrive and mirror it INTO
// the Hyperdrive. Hyperdrive.mirror() (called from the source side) walks
// the source, diffs it against the destination, and writes only what
// changed - each write becomes part of a new hyperdrive version.
async function addDirectory (name, sourceDir) {
  const entry = requireOwn(name)
  const opened = await openDrive(entry.storageDir)
  const src = new Localdrive(path.resolve(sourceDir))
  const mirror = src.mirror(opened.drive)
  await mirror.done()
  const result = { version: opened.drive.version, files: mirror.count.files }
  await closeDrive(opened)
  return result
}

// Use case: "Alice adds a file to her hyperdrive. This creates a new
// version." A single drive.put() appends new blocks to the drive's
// hypercore, which bumps drive.version - hyperdrives are versioned like
// git commits, one version per batch of writes.
async function addFile (name, localFilePath, drivePath) {
  const entry = requireOwn(name)
  const opened = await openDrive(entry.storageDir)
  const data = fs.readFileSync(localFilePath)
  const dest = drivePath || ('/' + path.basename(localFilePath))
  await opened.drive.put(dest, data)
  const version = opened.drive.version
  await closeDrive(opened)
  return { version, dest }
}

// Extract a single file from ANY known drive (our own, or a registered
// remote one) out to the normal filesystem. Used for the "Bob copies a file
// from Alice's hyperdrive" / "Alice retrieves the file with Bob's comments"
// steps - the actual copy is one drive.get() read + one fs.writeFile.
async function getFile (name, drivePath, localDestPath) {
  const entry = requireRegistered(name)
  const opened = await openDrive(entry.storageDir, entry.role === 'remote' ? entry.key : undefined)
  const data = await opened.drive.get(drivePath)
  if (!data) { await closeDrive(opened); throw new Error(`"${drivePath}" not found in drive "${name}"`) }
  fs.mkdirSync(path.dirname(path.resolve(localDestPath)), { recursive: true })
  fs.writeFileSync(localDestPath, data)
  await closeDrive(opened)
  return localDestPath
}

// Use case: "Alice/Bob seeds her/his hyperdrive to the DHT".
// Joining as { server: true, client: true } announces the drive's
// discovery key on the DHT and keeps the process running so it can accept
// incoming replication connections from anyone who looks that key up -
// this is what makes the data "seeded" and pull-able by others.
async function seed (name) {
  const entry = requireOwn(name)
  const { store, drive } = await openDrive(entry.storageDir)
  const swarm = await joinSwarm(store, drive, { server: true, client: true })
  console.log(`Seeding "${name}"`)
  console.log(`  public key : ${keyToHex(drive.key)}`)
  console.log(`  version    : ${drive.version}`)
  console.log('  Announced on the DHT. Leave this running so peers can connect. Ctrl+C to stop.')
  // Keep the process alive; clean up the swarm/corestore on exit.
  const shutdown = async () => { await swarm.destroy(); await closeDrive({ store, drive }); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await new Promise(() => {}) // never resolves - process stays up until Ctrl+C
}

// Use case: "list all the version numbers of a hyperdrive available to be
// pulled." For a remote drive this reflects whatever we could confirm from
// currently-reachable peers (same caveat as `diff`: if nobody's seeding
// right now, this is a best-effort/possibly-stale view, not a network-wide
// guarantee). `opts.max`, if given, caps how far back from the live version
// the range goes - e.g. max: 20 reports at most the most recent 20 version
// numbers rather than the drive's entire history.
async function versions (name, opts = {}) {
  const entry = requireRegistered(name)
  const session = await openAndSync(entry)
  const liveVersion = session.liveVersion
  let floor = BASELINE_VERSION
  if (opts.max != null && opts.max > 0) {
    floor = Math.max(BASELINE_VERSION, liveVersion - opts.max + 1)
  }
  await closeAndDisconnect(session)
  const range = []
  for (let v = floor; v <= liveVersion; v++) range.push(v)
  return {
    oldest: BASELINE_VERSION,
    liveVersion,
    floor,
    isRemote: session.isRemote,
    rangeText: compressRanges(range)
  }
}

// Use case: "Bob pulls the latest version of Alice's hyperdrive to a
// specified (empty) directory" - and later, "to the same directory" again -
// plus the newer "pull a specific version" capability.
//
// `name` must already be registered (own drives work too - pulling your own
// drive just exports your current content locally, with no networking).
// `destDir` is optional for a normal (latest-version) pull on a name that's
// been pulled before - it falls back to the directory recorded last time.
// `opts.version`, if given, checks out that historical version instead of
// the live one and mirrors THAT into destDir.
//
// Deliberate choice for version-pinned pulls: they do NOT update the
// registry's tracked `lastVersion`/`pullDir`, and they REQUIRE an explicit
// destDir rather than silently reusing the tracked pull directory. A
// version-pinned pull is treated as a one-off inspection, not a redefinition
// of "where you are" for future `diff`/plain `pull` calls - and it should
// never silently overwrite your regular synced copy with older content.
async function pull (name, destDir, opts = {}) {
  const entry = requireRegistered(name)
  const session = await openAndSync(entry)
  const liveVersion = session.liveVersion
  const pinnedVersion = opts.version != null ? opts.version : null

  if (pinnedVersion != null && (pinnedVersion < BASELINE_VERSION || pinnedVersion > liveVersion)) {
    const range = []
    for (let v = BASELINE_VERSION; v <= liveVersion; v++) range.push(v)
    await closeAndDisconnect(session)
    throw new Error(`Version ${pinnedVersion} does not exist for "${name}". Available versions: ${compressRanges(range)}`)
  }

  let resolvedDest = destDir ? path.resolve(destDir) : null
  if (!resolvedDest) {
    if (pinnedVersion != null) {
      await closeAndDisconnect(session)
      throw new Error('Pulling a specific version requires an explicit destination directory (so it can never silently overwrite your regular synced copy).')
    }
    resolvedDest = entry.pullDir ? path.resolve(entry.pullDir) : null
  }
  if (!resolvedDest) {
    await closeAndDisconnect(session)
    throw new Error(`No destination directory known for "${name}" yet; specify one.`)
  }

  const sourceDrive = pinnedVersion != null ? session.drive.checkout(pinnedVersion) : session.drive

  fs.mkdirSync(resolvedDest, { recursive: true })
  const dest = new Localdrive(resolvedDest)
  const mirror = sourceDrive.mirror(dest)
  await mirror.done()

  if (pinnedVersion == null) {
    registry.upsert(name, { pullDir: resolvedDest, lastVersion: liveVersion })
  }

  const result = {
    version: pinnedVersion != null ? pinnedVersion : liveVersion,
    files: mirror.count.files,
    destDir: resolvedDest,
    pinned: pinnedVersion != null
  }
  await closeAndDisconnect(session)
  return result
}

// Use case: "Bob compares the version of Alice's hyperdrive against the
// version of his copy of it." We briefly join the DHT to refresh our view
// of the drive's latest version (without necessarily downloading file
// contents), then compare that live version number against the version we
// recorded the last time we pulled, and list which paths changed via
// drive.diff(oldVersion, prefix) - which yields { left, right } pairs where
// left is the entry in the current/live version and right is the entry as
// it was at oldVersion (added: left only, deleted: right only, modified: both).
async function diff (name) {
  const entry = requireRegistered(name)
  if (entry.role !== 'remote') throw new Error(`"${name}" is one of your own drives - there's no separate "live" copy to diff against.`)
  const session = await openAndSync(entry)
  const remoteVersion = session.liveVersion
  const localVersion = entry.lastVersion || 0

  const changes = []
  if (remoteVersion !== localVersion) {
    for await (const change of session.drive.diff(localVersion, '/')) {
      changes.push(change)
    }
  }
  await closeAndDisconnect(session)
  return { localVersion, remoteVersion, upToDate: remoteVersion === localVersion, changes }
}

// Use case: "add a `ls` command which will list the directory structure of
// a hyperdrive." Works on any registered drive (own or remote) without
// requiring a prior pull - listing entries only reads the drive's small
// index (hyperbee) structure, not the file content blobs, so this is cheap
// even against a drive you've never pulled. See table in conversation for
// what metadata is available and why it's useful pre-pull (size in
// particular, which lets a user gauge a pull's cost before running it).
async function ls (name, opts = {}) {
  const entry = requireRegistered(name)
  const session = await openAndSync(entry)
  const entries = []
  for await (const file of session.drive.list('/', { recursive: true })) {
    entries.push(file)
  }
  await closeAndDisconnect(session)

  const totalBytes = entries.reduce((sum, e) => sum + (e.value.blob ? e.value.blob.byteLength : 0), 0)
  const text = renderListing(name, entry, session.liveVersion, entries, totalBytes)

  if (opts.output) {
    const outPath = path.resolve(opts.output)
    fs.writeFileSync(outPath, text)
    return { writtenTo: outPath, count: entries.length, totalBytes }
  }
  return { text, count: entries.length, totalBytes }
}

// -- ls rendering -------------------------------------------------------

// drive.list() yields a FLAT stream of full-path entries (hyperdrive has no
// separate "directory" object, only path prefixes) - this groups them back
// into a nested tree purely for display purposes.
function buildTree (entries) {
  const root = { children: {} }
  for (const e of entries) {
    const parts = e.key.split('/').filter(Boolean)
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]
      node.children[seg] = node.children[seg] || { children: {} }
      node = node.children[seg]
    }
    const leaf = parts[parts.length - 1]
    node.children[leaf] = {
      file: true,
      size: e.value.blob ? e.value.blob.byteLength : null,
      executable: !!e.value.executable,
      symlink: e.value.linkname || null
    }
  }
  return root
}

function renderTree (node, prefix, lines) {
  const names = Object.keys(node.children).sort()
  names.forEach((name, idx) => {
    const child = node.children[name]
    const isLast = idx === names.length - 1
    const connector = isLast ? '└── ' : '├── '
    let label = name
    if (child.file) {
      const bits = []
      if (child.symlink) bits.push(`-> ${child.symlink}`)
      else bits.push(formatBytes(child.size))
      if (child.executable) bits.push('exec')
      label += `  (${bits.join(', ')})`
    } else {
      label += '/'
    }
    lines.push(prefix + connector + label)
    if (!child.file) {
      renderTree(child, prefix + (isLast ? '    ' : '│   '), lines)
    }
  })
  return lines
}

function renderListing (name, entry, liveVersion, entries, totalBytes) {
  const lines = []
  lines.push(`${name}  [${entry.role}]  key=${entry.key.slice(0, 12)}...  version=${liveVersion}`)
  lines.push(`${entries.length} file(s), ${formatBytes(totalBytes)} total`)
  lines.push('')
  renderTree(buildTree(entries), '', lines)
  return lines.join('\n') + '\n'
}

function list () { return registry.all() }

async function info (name) {
  const entry = registry.get(name)
  if (!entry) throw new Error(`Unknown drive "${name}"`)
  // The public key never changes once a drive exists, so we can answer that
  // part straight from our own registry without touching the corestore at
  // all. This matters because a corestore's on-disk storage can only be
  // opened by one process at a time (e.g. while "seed" is running) - we
  // don't want "info" to fail just because the drive is currently seeding.
  const out = { name, role: entry.role, key: entry.key, storageDir: entry.storageDir, pullDir: entry.pullDir, version: null }
  try {
    const opened = await openDrive(entry.storageDir, entry.role === 'remote' ? entry.key : undefined)
    out.version = opened.drive.version
    await closeDrive(opened)
  } catch (err) {
    out.versionUnavailable = 'storage is currently locked by another running ftlbox process (e.g. "seed")'
  }
  return out
}

module.exports = {
  create, register, unregister, addDirectory, addFile, getFile, seed, pull, diff, versions, ls, info, list, keyToHex,
  BASELINE_VERSION,
  compressRanges, formatBytes, // exported for tests / potential reuse by future commands
  // exposed for the test harness (test/full-flow.js), which needs to keep
  // Alice's and Bob's drives "seeding" concurrently inside one Node process -
  // real usage never needs these directly, since each CLI command is its
  // own process.
  openDrive, closeDrive, joinSwarm
}

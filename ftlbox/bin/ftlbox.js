#!/usr/bin/env node
'use strict'
// FTLBOX command-line interface. This file only does argument parsing and
// printing - all the actual Pear/Hyperdrive/Hyperswarm work lives in
// lib/drive.js so it's easy to read in one place.
const drive = require('../lib/drive')

const VERSION = '0.02' // original release was 0.01

const HELP = `
FTLBOX v${VERSION} - a peer-to-peer file drop built on the Pear (Holepunch) stack
(corestore + hyperdrive + hyperswarm)

Usage:
  ftlbox create <name>                         create a new writable hyperdrive
  ftlbox register <name> <publicKeyHex> [--force]
                                                remember a name for someone else's drive
                                                (do this once before ls/versions/pull can use that name)
  ftlbox unregister <name>                     forget a registered name (does not delete pulled files)
  ftlbox add <name> <dir>                      add a local directory's contents to your drive
  ftlbox addfile <name> <file> [drivePath]     add a single local file to your drive
  ftlbox get <name> <drivePath> <outFile>      extract one file from a drive (yours or a registered one)
  ftlbox seed <name>                           announce your drive on the DHT and serve it (stays running)
  ftlbox ls <name> [-output <file>]            list a drive's directory structure and file sizes
  ftlbox versions <name> [--max N]             list version numbers available to pull
  ftlbox pull <name> [destDir] [--version N]   pull a drive (latest, or a specific version) by its registered name
  ftlbox diff <name>                           compare your last pull's version against the live one
  ftlbox info <name>                           show a drive's public key / version
  ftlbox list                                  list all drives FTLBOX knows about
`

// Pulls a flag like `--force` out of the args array (mutating it) and
// returns whether it was present.
function pluckBooleanFlag (args, names) {
  for (const n of names) {
    const idx = args.indexOf(n)
    if (idx !== -1) { args.splice(idx, 1); return true }
  }
  return false
}

// Pulls a flag+value like `--version 3` or `-output file.txt` out of the
// args array (mutating it) and returns the value (or undefined).
function pluckValueFlag (args, names) {
  for (const n of names) {
    const idx = args.indexOf(n)
    if (idx !== -1) {
      const value = args[idx + 1]
      args.splice(idx, 2)
      return value
    }
  }
  return undefined
}

function parseIntFlag (raw, flagLabel) {
  if (raw == null) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n)) throw new Error(`${flagLabel} must be a whole number, got "${raw}"`)
  return n
}

async function main () {
  const args = process.argv.slice(2)
  const cmd = args.shift()
  try {
    switch (cmd) {
      case 'create': {
        const [name] = args
        if (!name) throw new Error('usage: ftlbox create <name>')
        const key = await drive.create(name)
        console.log(`Created drive "${name}"`)
        console.log(`Public key: ${key}`)
        console.log('Share this key with your peer so they can "ftlbox register" it.')
        break
      }
      case 'register': {
        const force = pluckBooleanFlag(args, ['--force'])
        const [name, key] = args
        if (!name || !key) throw new Error('usage: ftlbox register <name> <publicKeyHex> [--force]')
        const entry = await drive.register(name, key, { force })
        console.log(`Registered "${name}" -> ${entry.key}`)
        console.log('You can now run "ls", "versions", or "pull" using just this name.')
        break
      }
      case 'unregister': {
        const [name] = args
        if (!name) throw new Error('usage: ftlbox unregister <name>')
        await drive.unregister(name)
        console.log(`Unregistered "${name}". (Any files already pulled to disk were left alone.)`)
        break
      }
      case 'add': {
        const [name, dir] = args
        if (!name || !dir) throw new Error('usage: ftlbox add <name> <dir>')
        const r = await drive.addDirectory(name, dir)
        console.log(`Added contents of "${dir}" to "${name}" -> version ${r.version} (${r.files} file(s) written/updated)`)
        break
      }
      case 'addfile': {
        const [name, file, drivePath] = args
        if (!name || !file) throw new Error('usage: ftlbox addfile <name> <file> [drivePath]')
        const r = await drive.addFile(name, file, drivePath)
        console.log(`Added "${file}" to "${name}" as "${r.dest}" -> new version ${r.version}`)
        break
      }
      case 'get': {
        const [name, drivePath, outFile] = args
        if (!name || !drivePath || !outFile) throw new Error('usage: ftlbox get <name> <drivePath> <outFile>')
        const out = await drive.getFile(name, drivePath, outFile)
        console.log(`Wrote "${drivePath}" from "${name}" to ${out}`)
        break
      }
      case 'seed': {
        const [name] = args
        if (!name) throw new Error('usage: ftlbox seed <name>')
        await drive.seed(name) // long-running; only returns on Ctrl+C
        break
      }
      case 'ls': {
        const outputPath = pluckValueFlag(args, ['-output', '--output'])
        const [name] = args
        if (!name) throw new Error('usage: ftlbox ls <name> [-output <file>]')
        const r = await drive.ls(name, { output: outputPath })
        if (r.writtenTo) {
          console.log(`Wrote listing for "${name}" to ${r.writtenTo} (${r.count} file(s), ${drive.formatBytes(r.totalBytes)} total)`)
        } else {
          process.stdout.write(r.text)
        }
        break
      }
      case 'versions': {
        const maxRaw = pluckValueFlag(args, ['--max'])
        const max = parseIntFlag(maxRaw, '--max')
        const [name] = args
        if (!name) throw new Error('usage: ftlbox versions <name> [--max N]')
        const r = await drive.versions(name, { max })
        console.log(`"${name}": versions ${r.rangeText} (live version ${r.liveVersion})${max ? ` [showing at most the last ${max}]` : ''}`)
        if (r.isRemote) console.log('(reflects whatever was reachable on the DHT just now - may be stale if nobody is currently seeding)')
        break
      }
      case 'pull': {
        const versionRaw = pluckValueFlag(args, ['--version'])
        const version = parseIntFlag(versionRaw, '--version')
        const [name, destDir] = args
        if (!name) throw new Error('usage: ftlbox pull <name> [destDir] [--version N]')
        const r = await drive.pull(name, destDir, { version })
        const pinnedNote = r.pinned ? ' (pinned version - your regularly tracked copy was not changed)' : ''
        console.log(`Pulled "${name}" (version ${r.version}) into ${r.destDir} (${r.files} file(s) written/updated)${pinnedNote}`)
        break
      }
      case 'diff': {
        const [name] = args
        if (!name) throw new Error('usage: ftlbox diff <name>')
        const r = await drive.diff(name)
        if (r.upToDate) {
          console.log(`"${name}" is up to date (version ${r.localVersion}).`)
        } else {
          console.log(`"${name}": local copy is version ${r.localVersion}, latest on the network is version ${r.remoteVersion}.`)
          console.log('Changed paths:')
          for (const c of r.changes) {
            // hyperdrive.diff(oldVersion) entries are shaped { left, right }:
            //   left  = the entry as it exists in the CURRENT/live version
            //   right = the entry as it existed in oldVersion
            // So: left+right -> modified, left only -> added, right only -> deleted.
            const kind = c.left && c.right ? 'modified' : c.left ? 'added' : 'deleted'
            const key = (c.left || c.right).key
            console.log(`  ${kind.padEnd(8)} ${key}`)
          }
        }
        break
      }
      case 'info': {
        const [name] = args
        if (!name) throw new Error('usage: ftlbox info <name>')
        const r = await drive.info(name)
        console.log(JSON.stringify(r, null, 2))
        break
      }
      case 'list': {
        const all = drive.list()
        if (Object.keys(all).length === 0) console.log('(no drives yet)')
        for (const [name, entry] of Object.entries(all)) {
          console.log(`${name}  [${entry.role}]  key=${entry.key}  ${entry.pullDir ? 'pullDir=' + entry.pullDir : ''}`)
        }
        break
      }
      default:
        console.log(HELP)
    }
  } catch (err) {
    console.error('Error:', err.message)
    process.exitCode = 1
  }
}

main()

'use strict'
// This test exercises the REAL lib/drive.js functions the CLI uses -
// register(), pull(), versions(), ls(), diff(), etc. - completely
// unmodified, for every operation EXCEPT the network transport itself:
// this sandbox's network policy blocks local/loopback connections, so a
// real Hyperswarm/DHT handshake can't be verified here. Instead we
// temporarily substitute drive.joinSwarm with an in-memory duplex stream
// pair (Node's stream.duplexPair) for the duration of each call that needs
// it - this drives the exact same store.replicate(stream) call that
// Hyperswarm's 'connection' handler makes, just fed a plain in-process
// stream instead of a real socket. Everything else (drive.update(),
// drive.mirror(), drive.diff(), drive.checkout(), versioning, the registry)
// runs for real, unmodified from the CLI's code path.
const { duplexPair } = require('stream')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

async function main () {
  const drive = require('../lib/drive.js')
  const registry = require('../lib/registry.js')
  const realJoinSwarm = drive.joinSwarm

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ftlbox-test-'))
  const aliceDir = path.join(root, 'alice'); fs.mkdirSync(aliceDir)
  const bobDir = path.join(root, 'bob'); fs.mkdirSync(bobDir)

  function inDir (dir, fn) {
    const prev = process.cwd()
    process.chdir(dir)
    return Promise.resolve().then(fn).finally(() => process.chdir(prev))
  }

  // A real Hyperswarm 'connection' object is a NoiseSecretStream, not a
  // bare duplex, so we wrap our in-memory pair the same way (encryption
  // keys are irrelevant here - only the framing/protocol interface
  // corestore.replicate expects matters for this test).
  const NoiseSecretStream = require('@hyperswarm/secret-stream')
  function replicatePair (storeA, storeB) {
    const [rawA, rawB] = duplexPair()
    const a = new NoiseSecretStream(true, rawA)
    const b = new NoiseSecretStream(false, rawB)
    storeA.replicate(a)
    storeB.replicate(b)
  }

  // Runs `fn` with drive.joinSwarm temporarily replaced by an in-memory
  // link to `remoteOpened`'s store, standing in for "the DHT found the peer
  // who's seeding this drive." Restores the real joinSwarm afterwards
  // regardless of success/failure, so this only affects the one call.
  async function withPeer (remoteOpened, fn) {
    drive.joinSwarm = async (store, driveObj) => {
      replicatePair(store, remoteOpened.store)
      return { destroy: async () => {} }
    }
    try {
      return await fn()
    } finally {
      drive.joinSwarm = realJoinSwarm
    }
  }

  const assert = (cond, msg) => { if (!cond) throw new Error('ASSERTION FAILED: ' + msg) }

  // 1. Alice creates a new hyperdrive and gets a public key
  let aliceKey, bobKey
  await inDir(aliceDir, async () => {
    fs.mkdirSync('mysrc')
    fs.writeFileSync('mysrc/hello.txt', 'hello world')
    fs.writeFileSync('mysrc/readme.md', 'readme content')
    aliceKey = await drive.create('alice-drive')
    assert(/^[0-9a-f]{64}$/.test(aliceKey), 'alice key looks like 32-byte hex')
  })

  // 2. Alice adds the contents of mysrc/ to her hyperdrive
  let versionBeforeNewfile
  await inDir(aliceDir, async () => {
    const r = await drive.addDirectory('alice-drive', 'mysrc')
    assert(r.files === 2, 'alice added 2 files, got ' + r.files)
    versionBeforeNewfile = r.version
    console.log('OK: alice-drive version after adding mysrc/ =', r.version)
  })

  // 5. Bob creates a new hyperdrive and gets a public key
  await inDir(bobDir, async () => {
    fs.mkdirSync('bobsrc')
    fs.writeFileSync('bobsrc/bobfile.txt', "bob's local file")
    bobKey = await drive.create('bob-drive')
    assert(/^[0-9a-f]{64}$/.test(bobKey), 'bob key looks like 32-byte hex')
  })

  // 6. Bob adds the contents of bobsrc/ to his hyperdrive
  await inDir(bobDir, async () => {
    const r = await drive.addDirectory('bob-drive', 'bobsrc')
    assert(r.files === 1, 'bob added 1 file, got ' + r.files)
  })

  // --- register-specific behavior -----------------------------------------
  await inDir(bobDir, async () => {
    // Invalid key format is rejected immediately, no network involved.
    let threw = false
    try { await drive.register('bad', 'not-a-key') } catch (e) { threw = true }
    assert(threw, 'register should reject a malformed key')

    // A name already used for one of YOUR OWN drives can never be
    // registered over, force or not.
    threw = false
    try { await drive.register('bob-drive', aliceKey) } catch (e) { threw = true }
    assert(threw, 'register should refuse to reuse an own-drive name')
  })

  await inDir(aliceDir, async () => {
    // Same own-drive guard, checked from Alice's side against her own name.
    let threw = false
    try { await drive.register('alice-drive', bobKey) } catch (e) { threw = true }
    assert(threw, 'register should refuse to reuse an own-drive name (alice side)')
  })

  await inDir(bobDir, async () => {
    // Re-registering a throwaway name to a different key without --force
    // is rejected; the same call with --force succeeds; re-registering to
    // the SAME key is always a harmless no-op either way.
    const fakeKeyA = crypto.randomBytes(32).toString('hex')
    const fakeKeyB = crypto.randomBytes(32).toString('hex')
    await drive.register('throwaway', fakeKeyA)
    let threw = false
    try { await drive.register('throwaway', fakeKeyB) } catch (e) { threw = true }
    assert(threw, 'register onto an existing name with a different key should require --force')
    const entry = await drive.register('throwaway', fakeKeyA) // same key again - no-op
    assert(entry.key === fakeKeyA, 'idempotent re-register keeps the same key')
    await drive.register('throwaway', fakeKeyB, { force: true })
    assert(registry.get('throwaway').key === fakeKeyB, '--force should overwrite to the new key')

    // unregister: works on a registered remote name, refuses on unknown
    // names and on your own drives, and leaves nothing else behind.
    await drive.unregister('throwaway')
    assert(!registry.get('throwaway'), 'unregister should remove the registry entry')
    threw = false
    try { await drive.unregister('throwaway') } catch (e) { threw = true }
    assert(threw, 'unregister should refuse an unknown name')
    threw = false
    try { await drive.unregister('bob-drive') } catch (e) { threw = true }
    assert(threw, 'unregister should refuse one of your own drives')

    // Now register alice-drive for real, under the name Bob will use
    // for the rest of the test.
    await drive.register('alice-copy', aliceKey)
    assert(registry.get('alice-copy').role === 'remote', 'registered entry has role "remote"')
  })
  console.log('OK: register/unregister edge cases all behaved as expected')

  // 3/7. "Seed" both drives: open them and keep them open so a replication
  // link can be attached, standing in for a real long-running `ftlbox seed`
  // process that's announced on the DHT and accepting connections.
  const aliceEntry = await inDir(aliceDir, () => registry.get('alice-drive'))
  const bobEntry = await inDir(bobDir, () => registry.get('bob-drive'))
  let aliceOpened = await drive.openDrive(aliceEntry.storageDir)
  let bobOpened = await drive.openDrive(bobEntry.storageDir)
  console.log('Both Alice and Bob are now "seeding" (replication link open).')

  // --- ls, before Bob has ever pulled -------------------------------------
  // ls works purely off the drive's index (sizes etc.) without needing a
  // prior pull - this is the "look before you leap" use case.
  await inDir(bobDir, async () => {
    const r = await withPeer(aliceOpened, () => drive.ls('alice-copy'))
    assert(r.count === 2, 'ls should see 2 files before any pull, got ' + r.count)
    assert(r.text.includes('hello.txt'), 'ls output should mention hello.txt')
    assert(r.totalBytes === 'hello world'.length + 'readme content'.length, 'ls total size should match file contents exactly')
    assert(!registry.get('alice-copy').pullDir, 'ls must not have pulled anything or set pullDir')
    console.log('OK: ls (pre-pull) reported', r.count, 'files,', r.totalBytes, 'bytes total')

    // -output flag: same listing, written to a file instead of stdout.
    const outFile = path.join(bobDir, 'listing.txt')
    const r2 = await withPeer(aliceOpened, () => drive.ls('alice-copy', { output: outFile }))
    assert(r2.writtenTo === outFile, 'ls --output should report the file it wrote')
    const written = fs.readFileSync(outFile, 'utf8')
    assert(written.includes('readme.md'), '-output file should contain the real listing')
    console.log('OK: ls -output wrote a real listing to disk')
  })

  // --- versions, before Bob has ever pulled -------------------------------
  await inDir(bobDir, async () => {
    const r = await withPeer(aliceOpened, () => drive.versions('alice-copy'))
    assert(r.liveVersion === versionBeforeNewfile, 'versions should report the live version, got ' + r.liveVersion)
    assert(r.rangeText === `${drive.BASELINE_VERSION}-${versionBeforeNewfile}`, 'whole-drive range should be one contiguous span, got ' + r.rangeText)

    const capped = await withPeer(aliceOpened, () => drive.versions('alice-copy', { max: 1 }))
    assert(capped.rangeText === `${versionBeforeNewfile}`, '--max 1 should show only the single latest version, got ' + capped.rangeText)
    console.log('OK: versions reports', r.rangeText, '(and --max 1 correctly narrows to', capped.rangeText + ')')
  })

  // 9. Bob pulls the latest version of Alice's hyperdrive into an empty dir,
  // now using just the registered name (no key, per the name-based pull).
  await inDir(bobDir, async () => {
    const r = await withPeer(aliceOpened, () => drive.pull('alice-copy', 'bob-pulled-from-alice'))
    assert(r.files === 2, 'bob pulled 2 files from alice, got ' + r.files)
    assert(r.pinned === false, 'a plain pull should not be marked as pinned')
    const txt = fs.readFileSync('bob-pulled-from-alice/hello.txt', 'utf8')
    assert(txt === 'hello world', 'pulled file content matches: ' + txt)
    console.log('OK: Bob pulled alice-drive (by name only) ->', fs.readdirSync('bob-pulled-from-alice'))
  })

  // 10. Alice adds a file to her hyperdrive -> new version.
  // Corestore storage can only be held open by one process/instance at a
  // time, so - exactly like a real `ftlbox seed` process would have to be
  // stopped before another `ftlbox` command can write to the same drive -
  // we close the long-lived "seeding" handle first, and reopen it after
  // (simulating Alice Ctrl+C'ing seed, running addfile, then restarting seed).
  await drive.closeDrive(aliceOpened)
  let aliceVersionAfterAdd
  await inDir(aliceDir, async () => {
    fs.writeFileSync('newfile.txt', 'a brand new file from alice')
    const r = await drive.addFile('alice-drive', 'newfile.txt', '/newfile.txt')
    assert(r.version > versionBeforeNewfile, 'alice drive version should have increased, was ' + versionBeforeNewfile + ' now ' + r.version)
    aliceVersionAfterAdd = r.version
    console.log('OK: alice-drive is now version', r.version)
  })
  aliceOpened = await drive.openDrive(aliceEntry.storageDir)

  // 11. Bob compares his copy's version against Alice's live version
  await inDir(bobDir, async () => {
    const r = await withPeer(aliceOpened, () => drive.diff('alice-copy'))
    assert(r.upToDate === false, 'bob should see a pending update')
    assert(r.remoteVersion === aliceVersionAfterAdd, 'remote should report latest alice version ' + aliceVersionAfterAdd + ', got ' + r.remoteVersion)
    const added = r.changes.find(c => c.left && c.left.key === '/newfile.txt')
    assert(added, 'diff should list /newfile.txt as changed (added)')
    console.log('OK: diff shows local v' + r.localVersion + ' vs remote v' + r.remoteVersion, '- changes:', r.changes.map(c => (c.left || c.right).key))
  })

  // 12. Bob re-pulls into the SAME directory - no destDir needed this time,
  // it's recalled from the registry automatically (name-based pull).
  await inDir(bobDir, async () => {
    const r = await withPeer(aliceOpened, () => drive.pull('alice-copy'))
    assert(r.version === aliceVersionAfterAdd, 'after re-pull bob should match alice version ' + aliceVersionAfterAdd + ', got ' + r.version)
    const txt = fs.readFileSync('bob-pulled-from-alice/newfile.txt', 'utf8')
    assert(txt === 'a brand new file from alice', 'new file content correct: ' + txt)
    console.log('OK: re-pull into same dir (destDir recalled by name) now contains', fs.readdirSync('bob-pulled-from-alice'))
  })

  // --- pull a specific (older) version, into a required separate dir -----
  await inDir(bobDir, async () => {
    // Omitting destDir on a version-pinned pull must be refused - it must
    // never silently overwrite the regular tracked copy.
    let threw = false
    try { await withPeer(aliceOpened, () => drive.pull('alice-copy', undefined, { version: versionBeforeNewfile })) } catch (e) { threw = true }
    assert(threw, 'version-pinned pull without an explicit destDir should be refused')

    const r = await withPeer(aliceOpened, () => drive.pull('alice-copy', 'bob-alice-old-version', { version: versionBeforeNewfile }))
    assert(r.pinned === true, 'version-pinned pull should be marked as pinned')
    assert(!fs.existsSync('bob-alice-old-version/newfile.txt'), 'old version snapshot should NOT contain the file added later')
    assert(fs.existsSync('bob-alice-old-version/hello.txt'), 'old version snapshot should still contain the original files')

    // Confirm the pinned pull did NOT disturb the regularly tracked copy's
    // bookkeeping - diff should still compare against the latest real pull.
    const entryAfter = registry.get('alice-copy')
    assert(entryAfter.lastVersion === aliceVersionAfterAdd, 'pinned pull must not change the tracked lastVersion, got ' + entryAfter.lastVersion)
    assert(entryAfter.pullDir === path.resolve('bob-pulled-from-alice'), 'pinned pull must not change the tracked pullDir')
    console.log('OK: version-pinned pull fetched v' + versionBeforeNewfile + ' into a separate dir without touching tracked state')

    // An out-of-range version is rejected with a clear, range-aware error.
    threw = false
    try {
      await withPeer(aliceOpened, () => drive.pull('alice-copy', 'bob-alice-bad-version', { version: aliceVersionAfterAdd + 100 }))
    } catch (e) {
      threw = true
      assert(/does not exist/.test(e.message), 'out-of-range version error should say it does not exist: ' + e.message)
      console.log('OK: out-of-range version correctly rejected ->', e.message)
    }
    assert(threw, 'pulling a version beyond the live version should throw')
  })

  // 13/14. Bob "copies" a file out of Alice's drive into his own drive, edits it
  await drive.closeDrive(bobOpened)
  await inDir(bobDir, async () => {
    await drive.getFile('alice-copy', '/newfile.txt', 'extracted-newfile.txt')
    let content = fs.readFileSync('extracted-newfile.txt', 'utf8')
    content += '\n\n[Bob] looks good, minor comment: nice work!'
    fs.writeFileSync('extracted-newfile.txt', content)
    const r = await drive.addFile('bob-drive', 'extracted-newfile.txt', '/newfile-with-comments.txt')
    console.log('OK: bob added commented file to bob-drive, version', r.version)
  })
  bobOpened = await drive.openDrive(bobEntry.storageDir)

  // 15. Alice pulls Bob's drive and retrieves the commented file - register
  // then pull by name, same as Bob did for Alice's drive.
  await inDir(aliceDir, async () => {
    await drive.register('bob-copy', bobKey)
    await withPeer(bobOpened, () => drive.pull('bob-copy', 'alice-pulled-from-bob'))
    assert(fs.existsSync('alice-pulled-from-bob/newfile-with-comments.txt'), 'commented file present')
    const finalText = fs.readFileSync('alice-pulled-from-bob/newfile-with-comments.txt', 'utf8')
    assert(finalText.includes('Bob'), 'comment text present')
    console.log('OK: alice retrieved commented file:\n---\n' + finalText + '\n---')
  })

  await drive.closeDrive(aliceOpened)
  await drive.closeDrive(bobOpened)

  console.log('\nALL USE CASES PASSED (replication verified over an in-memory stream since this sandbox blocks local network connections; DHT/Hyperswarm join logic is unchanged - only the transport differs, see README)')
  process.exit(0)
}

main().catch(err => { console.error('TEST FAILED:', err); process.exit(1) })

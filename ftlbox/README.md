# FTLBOX v0.02

A terminal application for sharing and syncing folders peer-to-peer, with
no central server. Built directly on the modules that power the [Pear
runtime](https://pears.com/) (Holepunch's P2P stack):

| Module        | What it's used for here                                                   |
|---------------|-----------------------------------------------------------------------------|
| `corestore`   | Local on-disk storage for the append-only logs ("hypercores") a drive is built from. |
| `hyperdrive`  | A versioned, file-system-like structure (put/get/list/diff/mirror/checkout) stored as a hypercore. |
| `hyperswarm`  | Peer-to-peer networking: announces/looks up drives on the **DHT** (Distributed Hash Table) and opens encrypted connections to peers. |
| `localdrive`  | Wraps a normal folder so it can be mirrored to/from a hyperdrive with the same API. |

Every drive is identified by a 32-byte **public key**. Whoever has that key
can find and replicate the drive over the DHT - there is no server, no
account, no central index.

> **What's new in v0.02:** a `register`/`unregister` step now stands between
> "someone gave me a key" and "I can pull/inspect it" (see below) - once
> registered, `ls`, `versions`, and `pull` all just take the short name, no
> key needed. `pull` can now also fetch a specific historical version, and
> two new read-only commands (`ls`, `versions`) let you look at a drive's
> contents and history before deciding whether to pull it at all.

---

## 1. Installation

FTLBOX is a plain Node.js CLI (Node 18+ recommended) that uses the same
building blocks the Pear runtime is built on.

Both Alice and Bob run the same steps, each on their own machine:

```bash
# 1. Get the code (copy the ftlbox/ folder you were given, or clone your repo)
cd ftlbox

# 2. Install dependencies
npm install

# 3. (optional) Install it as a global command
npm link
# now you can just type `ftlbox ...` instead of `node bin/ftlbox.js ...`
```

If you'd rather run it through the actual **Pear** runtime instead of plain
Node (e.g. to eventually ship it as a `pear://` link others can run with
`pear run`), install Pear globally and run the same entry point through it:

```bash
npm install -g pear
pear run . create alice-drive     # runs bin/ftlbox.js inside the Pear runtime
```

Everything below assumes the plain-Node form, `node bin/ftlbox.js ...`
(or `ftlbox ...` after `npm link`). Run every command from inside the
`ftlbox/` project folder - FTLBOX keeps a small `ftlbox.json` registry file
and an `ftlbox-data/` storage folder there to remember your drives between
commands.

> Tip: if Alice and Bob are testing on the **same** machine, just check out
> two separate copies of the `ftlbox/` folder (e.g. `alice/` and `bob/`) so
> their registries and storage don't collide, and `cd` into the right one
> for each command below.

---

## 2. Command reference

```
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
```

`<name>` is a short local label you choose. Every command after `register`
uses just that name - never a raw key - so there's no ambiguity about
whether something typed on the command line is a name or a public key.

---

## 3. Walkthrough of every use case

### Alice creates and shares her drive

```bash
# Alice creates a new hyperdrive and gets a public key
ftlbox create alice-drive
#   Created drive "alice-drive"
#   Public key: 6e2f...<64 hex chars>...

# Alice adds the contents of a directory to her hyperdrive
ftlbox add alice-drive ./my-project

# Alice seeds her hyperdrive to the DHT (this announces it and keeps running -
# leave this terminal open; peers can only pull while this is running,
# unless you re-run `seed` later)
ftlbox seed alice-drive

# Alice sends Bob her public key (outside the scope of this system - text
# it, email it, read it out loud, whatever)
```

### Bob registers Alice's key, looks around, then pulls

```bash
# Bob creates his own drive, same as Alice did
ftlbox create bob-drive
ftlbox add bob-drive ./bobs-stuff
ftlbox seed bob-drive   # leave running, in another terminal/tab

# Bob registers Alice's public key under a name he'll use from now on.
# This is purely local bookkeeping - no network call happens here.
ftlbox register alice-copy 6e2f...aliceskeyhex...
#   Registered "alice-copy" -> 6e2f...
#   You can now run "ls", "versions", or "pull" using just this name.

# Before committing to a pull, Bob can look at what's actually in the
# drive - this only reads the drive's small index, not file content, so
# it's cheap even for a drive he's never pulled:
ftlbox ls alice-copy
#   alice-copy  [remote]  key=6e2f12ab34cd...  version=2
#   14 file(s), 3.2 MB total
#
#   ├── README.md  (1.1 KB)
#   └── src/
#       ├── index.js  (4.5 KB)
#       └── ...

# ...and check what version history is available:
ftlbox versions alice-copy
#   "alice-copy": versions 1-2 (live version 2)
#   (reflects whatever was reachable on the DHT just now - may be stale if
#   nobody is currently seeding)

# Now Bob pulls the latest version into an empty directory
ftlbox pull alice-copy ./alice-copy
#   Pulled "alice-copy" (version 2) into /.../alice-copy (14 file(s) written/updated)
```

### Alice updates her drive; Bob notices and re-pulls

```bash
# Alice adds a file to her hyperdrive - this creates a new version
ftlbox addfile alice-drive ./notes/plan.md /plan.md
#   Added "./notes/plan.md" to "alice-drive" as "/plan.md" -> new version 3

# (Alice's `seed` process needs to be running for Bob to see this.)

# Bob compares his pulled copy's version against the live version on the network
ftlbox diff alice-copy
#   "alice-copy": local copy is version 2, latest on the network is version 3.
#   Changed paths:
#     added    /plan.md

# Bob re-pulls - no destination needed this time, FTLBOX remembers where
# he pulled it to last time
ftlbox pull alice-copy
#   Pulled "alice-copy" (version 3) into /.../alice-copy (1 file(s) written/updated)
```

### Pulling a specific historical version

```bash
# See what version numbers actually exist first
ftlbox versions alice-copy --max 5
#   "alice-copy": versions 1-3 (live version 3) [showing at most the last 5]

# Pull version 1 specifically - note this REQUIRES an explicit destination
# directory (it will never silently reuse/overwrite your regular pulled
# copy), and it does NOT change what `diff`/plain `pull` think of as "your
# copy" - it's a one-off, read-only look at history.
ftlbox pull alice-copy ./alice-copy-v1 --version 1
#   Pulled "alice-copy" (version 1) into /.../alice-copy-v1 (2 file(s) written/updated) (pinned version - your regularly tracked copy was not changed)

# Asking for a version that doesn't exist gives a clear error, not a hang:
ftlbox pull alice-copy ./oops --version 999
#   Error: Version 999 does not exist for "alice-copy". Available versions: 1-3
```

### Bob edits a file from Alice's drive and sends it back

```bash
# Bob copies a file from Alice's hyperdrive to his own hyperdrive
#   (a) pull it out to a normal file:
ftlbox get alice-copy /plan.md ./plan-with-comments.md
#   (b) edit it (outside the scope of this system - open it in any editor)
#       ...Bob adds his comments to plan-with-comments.md...
#   (c) add the edited file into Bob's own drive:
ftlbox addfile bob-drive ./plan-with-comments.md /plan-with-comments.md

# Bob's `seed bob-drive` process (already running) will now serve this new
# version automatically.

# Alice registers Bob's key (once) and pulls the latest version of his drive
ftlbox register bob-copy 9a1c...bobskeyhex...
ftlbox pull bob-copy ./bob-copy
ftlbox get bob-copy /plan-with-comments.md ./plan-with-comments.md
```

### Cleaning up a registration you no longer need

```bash
ftlbox unregister alice-copy
#   Unregistered "alice-copy". (Any files already pulled to disk were left alone.)
```

`unregister` only forgets the name -> key mapping; it never deletes files
you already pulled to disk. You can `register` the same key again later
under the same or a different name.

---

## 4. Design notes on the v0.02 changes

- **Why registration is mandatory now:** earlier versions let you pass
  either a name or a raw key to `pull`, and guessed which one you meant.
  That guess had a real (if rare) ambiguity: a name that happened to be 64
  hex characters would look exactly like a key. Requiring `register` first
  removes the guesswork - every other command's first argument is always,
  unambiguously, a name. It also matches `git remote add <name> <url>`,
  which most people already have a mental model for.
- **Why a version-pinned `pull` doesn't touch `lastVersion`/`pullDir`:** the
  registry's tracked state is what `diff` and a plain re-`pull` use to mean
  "where you are." Pulling an old version on purpose is a one-off look at
  history, not a redefinition of that - so it's kept out of the bookkeeping
  entirely, and for the same reason it requires an explicit destination
  directory rather than being allowed to quietly reuse (and overwrite) the
  regular pull directory.
- **Why `ls`/`versions` work without a prior `pull`:** listing a drive's
  entries or its version count only reads the drive's small index
  (a hyperbee B-tree) - not the actual file content blobs - so both commands
  are cheap even against a drive you've never synced. This is what makes
  them useful as "look before you leap" tools ahead of a potentially large
  `pull`.
- **What `ls` shows, and why it's useful before pulling:** each entry in a
  hyperdrive carries `blob.byteLength` (file size, without downloading the
  file), `executable`, and `linkname` (non-null means it's a symlink, not
  real content) directly in the index. Size is the standout one - it lets
  you judge how big a pull will be before committing to it, which nothing
  else in the CLI could tell you before.
- **Why whole-drive `versions` almost always shows one single range:**
  hypercore's version counter is a strict append-only sequence - it can
  never skip a number - so a whole-drive version listing is always one
  contiguous span (e.g. `1-8`) under normal operation. The hyphen-range
  compression is still implemented generically (any list of numbers, not
  just contiguous ones) so it's ready to be reused for something genuinely
  sparse later, like "which versions touched this one file."

---

## 5. Project layout

```
ftlbox/
  bin/ftlbox.js     CLI entry point (argument parsing + dispatch only)
  lib/drive.js       all Pear/Hyperdrive/Hyperswarm logic, heavily commented
  lib/registry.js    local bookkeeping (ftlbox.json) mapping names -> keys/paths
  test/full-flow.js  automated end-to-end test of every use case above
  package.json
```

Run `npm test` to exercise the full Alice/Bob workflow automatically,
including register/unregister edge cases, `ls`, `versions`, and
version-pinned `pull`. (The test calls the real `lib/drive.js` functions
unmodified and only substitutes the network join with an in-memory stream,
since this can run in restricted/offline CI environments; in normal use,
`seed`/`pull`/`diff`/`versions`/`ls` talk to the real DHT via Hyperswarm
exactly as described above.)

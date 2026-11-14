/**
 * Race fixture: one process, one grab attempt, released at a shared start
 * instant.
 *
 * Modes, so a test can compare the primitives:
 *   dir-recursive -> fs.mkdirSync(target, { recursive: true })
 *                    The idempotent form: it returns happily when the target
 *                    already exists, so EVERY racer "wins". This is the
 *                    directory-as-lock trap in its natural Node shape (the
 *                    PowerShell equivalent in DESIGN.md section 7 is
 *                    New-Item -ItemType Directory -Force).
 *   dir           -> fs.mkdirSync(target)   throws EEXIST: one winner, but the
 *                    lock cannot carry the lease body atomically.
 *   wx            -> fs.openSync(target, 'wx')   O_CREAT|O_EXCL, the right one.
 *
 * The busy-wait on `startAt` is what makes the race real: spawning N children
 * takes tens of milliseconds, so without a common start line the first one
 * finishes before the last one starts and the race is never exercised.
 *
 * Usage: node raw-race-child.mjs <dir-recursive|dir|wx> <target> <startAtEpochMs>
 * Prints one JSON line: {"won":true|false,"error":"..."}
 */

import fs from 'node:fs'
import process from 'node:process'

const [, , mode, target, startAtRaw] = process.argv
const startAt = Number(startAtRaw)

if (!mode || !target || !Number.isFinite(startAt)) {
  process.stdout.write(`${JSON.stringify({ won: false, error: 'bad arguments to raw-race-child.mjs' })}\n`)
  process.exit(3)
}

// Wait for the shared start line. Spin rather than sleep: setTimeout can be a
// millisecond or two late, and this fixture is about razor-thin margins.
while (Date.now() < startAt) {
  /* spin */
}

let won = false
let error = ''
try {
  if (mode === 'dir-recursive') {
    fs.mkdirSync(target, { recursive: true })
    won = true
  } else if (mode === 'dir') {
    fs.mkdirSync(target)
    won = true
  } else {
    const fd = fs.openSync(target, 'wx')
    try {
      fs.writeFileSync(fd, String(process.pid))
    } finally {
      fs.closeSync(fd)
    }
    won = true
  }
} catch (err) {
  error = err && err.code ? String(err.code) : String(err)
}

process.stdout.write(`${JSON.stringify({ won, error, pid: process.pid })}\n`)
process.exit(0)

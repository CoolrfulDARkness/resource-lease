#!/usr/bin/env node
/**
 * Resource algebra test -- the pure-logic half of RESOURCE-MODEL-v2.
 *
 * Covers the rows of §11 that are decided without any filesystem, plus the
 * canonical-form edge cases that the CLI and the plugin must agree on:
 *
 *   §11 2   path:D:/out vs path:D:/out/sub        -> conflict (ancestor)
 *   §11 3   path:D:/out vs path:D:/out2           -> NO conflict (per segment)
 *   §11 4   browser:profile:work vs path:<dir>    -> conflict (facet)
 *   §11 5   port:9222 vs port:9220-9230           -> conflict (range)
 *   §11 10  shared + shared                       -> no conflict
 *   §11 11  shared + exclusive                    -> conflict
 *   §3.3    screen:focus vs window:hwnd:<n>       -> NO conflict
 *   §2      path canonicalisation: drive case, slash direction, ./.., trailing
 *           separator, root, relative-vs-absolute
 *   §3.4    the global order: total (distinct facets never tie), stable, and
 *           independent of the caller's request order
 *
 * Usage: node --test resource-lease/plugin/test/resources.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  API_METRICS,
  CLASSES,
  CLASS_NAMES,
  IMPLICATIONS,
  MODES,
  canonicalKey,
  canonicalPath,
  compareFacets,
  expandFacets,
  expandReport,
  facetsConflict,
  findConflicts,
  getAliases,
  getProfileDirs,
  keysConflict,
  normalizeMode,
  orderKey,
  parseKey,
  pathKey,
  sanitizeKey,
  setAliases,
  setProfileDirs,
  sortFacets,
  unresolvedAliases,
} from '../lib/resources.js'

/** The Windows profile directory used for the §11 #4 cases. */
const PROFILE_DIR = 'C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data'
const PROFILE_DIR_CANONICAL = 'path:c:/users/x/appdata/local/google/chrome/user data'
/** The same directory as a resource KEY -- a bare path is not a key. */
const PROFILE_KEY = `path:${PROFILE_DIR}`

/* ------------------------------------------------------------------ §2 */

test('§2 path: drive letter lowercased, backslashes to slashes, trailing slash dropped', () => {
  assert.equal(canonicalKey('path:D:\\Out\\'), 'path:d:/out')
  assert.equal(canonicalKey('path:D:/Out'), 'path:d:/out')
  assert.equal(canonicalKey('path:D:\\Out\\Sub\\\\'), 'path:d:/out/sub')
})

test('§2 path: whole string lowercased (case-insensitive filesystem)', () => {
  assert.equal(canonicalKey('path:D:/OUT/Sub'), 'path:d:/out/sub')
  assert.equal(canonicalKey(canonicalKey('path:D:/OUT/Sub')), 'path:d:/out/sub')
})

test('§2 path: "." and ".." resolved', () => {
  assert.equal(canonicalKey('path:D:/out/./sub'), 'path:d:/out/sub')
  assert.equal(canonicalKey('path:D:/out/sub/../other'), 'path:d:/out/other')
  assert.equal(canonicalKey('path:D:/out/../../escape'), 'path:d:/escape')
  assert.equal(canonicalKey('path:D:/out/..'), 'path:d:/')
})

test('§2 path: root keeps its separator, trailing separators elsewhere are dropped', () => {
  assert.equal(canonicalKey('path:D:/'), 'path:d:/')
  assert.equal(canonicalKey('path:D:\\'), 'path:d:/')
  assert.equal(canonicalKey('path:/'), 'path:/')
  assert.equal(canonicalKey('path:/usr/local/'), 'path:/usr/local')
  // UNC keeps its leading double separator: collapsing it to '/' would make
  // \\server\share a *different* resource from //server/share, and two agents
  // on the two spellings would stop excluding each other.
  assert.equal(canonicalKey(String.raw`path:\\server\share\dir`), 'path://server/share/dir')
  assert.equal(canonicalKey('path://server/share/dir/'), 'path://server/share/dir')
  // A single leading separator is POSIX-absolute, not UNC -- and must stay that way.
  assert.equal(canonicalKey(String.raw`path:\server\share\dir`), 'path:/server/share/dir')
})

test('§2 path: canonical form is idempotent; relative paths need an explicit base', () => {
  const samples = [
    'path:D:/out',
    'path:d:/',
    'path:/usr/local/bin',
    'path://server/share/x',
    'path:D:/a/b/../c/./',
  ]
  for (const key of samples) assert.equal(canonicalKey(canonicalKey(key)), canonicalKey(key))

  // A relative path is resolved ONLY when the caller supplied a base -- that is the
  // caller saying which directory it means. See the next test for the rejection.
  assert.equal(canonicalKey('path:out', { base: 'D:/work' }), 'path:d:/work/out')
  assert.equal(canonicalKey('path:../up', { base: 'D:/work/deep' }), 'path:d:/work/up')
  assert.throws(() => canonicalPath(''), /must not be empty/)
  assert.throws(() => canonicalPath('   '), /must not be empty/)
  // A relative BASE is not a base: it would put the cwd back in the middle.
  assert.throws(() => canonicalPath('out', { base: 'relative/base' }), /must itself be absolute/)
})

test('§2 a relative path key is a HARD ERROR, never a cwd guess (B2)', () => {
  // §2: "相对路径一律报参数错误(插件抛错、CLI 退出码 3),不猜、不用 cwd 兜底".
  // The canonical form must not depend on the process's directory, or two agents
  // running in different directories hold two different locks for ONE directory
  // and exclusion fails silently -- the dangerous direction.
  for (const key of ['path:out', 'path:./sub', 'path:../up', 'path:sub/dir']) {
    assert.throws(() => canonicalKey(key), /must be ABSOLUTE/, `${key} must be refused`)
    assert.throws(() => parseKey(key), /must be ABSOLUTE/, `${key} must be refused by parseKey too`)
    assert.throws(() => expandFacets(key), /must be ABSOLUTE/, `${key} must not expand`)
  }
  // Drive-relative is cwd-dependent on that drive: the CLI rejects it (exit 3), so
  // the plugin must too, or the same spelling would be a key on one side only.
  assert.throws(() => canonicalKey('path:C:out'), /drive-relative/)
  assert.throws(() => canonicalKey('path:C:'), /drive-relative/)

  // Nothing above was resolved against the cwd, so the answer cannot change with it.
  assert.equal(canonicalKey('path:D:/out'), 'path:d:/out')
  assert.equal(canonicalKey('path:/usr/local'), 'path:/usr/local')

  // pathKey() is the documented way to pass a BARE path (§2 last bullet), so it
  // resolves one itself instead of refusing it.
  assert.equal(pathKey('out', { base: 'D:/work' }), 'path:d:/work/out')
  assert.equal(pathKey('C:\\Out\\', undefined), 'path:c:/out')
  assert.equal(pathKey('out'), `path:${process.cwd().replace(/\\/g, '/').toLowerCase()}/out`)
  assert.throws(() => pathKey(''), /must not be empty/)
})

test('§2 path: does not resolve symlinks (documented blind spot)', () => {
  // A pure canonicaliser cannot and must not touch the filesystem: the string
  // stays exactly as written, only normalised.
  assert.equal(canonicalKey('path:D:/link/to/target'), 'path:d:/link/to/target')
})

test('§2 port: no leading zeros, range keeps lo-hi, degenerate range collapses', () => {
  assert.equal(canonicalKey('port:09222'), 'port:9222')
  assert.equal(canonicalKey('port:9220-9230'), 'port:9220-9230')
  assert.equal(canonicalKey('port:0920-09230'), 'port:920-9230')
  assert.equal(canonicalKey('port:9222-9222'), 'port:9222')
  assert.throws(() => canonicalKey('port:9230-9220'), /lo <= hi/)
  assert.throws(() => canonicalKey('port:http'), /not a port/)
  assert.throws(() => canonicalKey('port:70000'), /outside the port range/)
})

test('§2 proc / window / api / named canonical forms', () => {
  assert.equal(canonicalKey('proc:Build'), 'proc:build')
  assert.equal(canonicalKey('proc:pid:01234'), 'proc:pid:1234')
  assert.throws(() => canonicalKey('proc:pid:abc'), /decimal/)

  assert.equal(canonicalKey('window:hwnd:197772'), 'window:hwnd:197772')
  assert.equal(canonicalKey('window:HWND:000197772'), 'window:hwnd:197772')
  assert.equal(canonicalKey('window:197772'), 'window:hwnd:197772')

  for (const metric of API_METRICS) {
    assert.equal(canonicalKey(`api:OpenAI:${metric.toUpperCase()}`), `api:openai:${metric}`)
  }
  assert.throws(() => canonicalKey('api:openai:qps'), /unknown api metric/)
  assert.throws(() => canonicalKey('api:openai'), /api keys are/)

  assert.equal(canonicalKey('named:NPM-Publish'), 'named:npm-publish')
})

test('§2 sanitizeKey: byte-identical to the v1 / CLI filename rule', () => {
  assert.equal(sanitizeKey('path:d:/out'), 'path_d__out')
  assert.equal(sanitizeKey('browser:profile:work'), 'browser_profile_work')
  assert.equal(sanitizeKey('Path:D:/Out'), 'path_d__out')
  // ':' and '/' both collapse to '_', so the v1 filename for dir:src/parser is
  // unchanged even though the canonical form joins with ':'.
  assert.equal(sanitizeKey('dir:src/parser'), 'dir_src_parser')
  assert.equal(sanitizeKey('dir:src:parser'), 'dir_src_parser')
})

test('§2 parseKey: structural errors are hard errors, unknown classes are opaque', () => {
  assert.throws(() => parseKey(''), /must not be empty/)
  assert.throws(() => parseKey('port'), /not a resource key/)
  assert.throws(() => parseKey(':9222'), /not a resource key/)
  assert.throws(() => parseKey('port:'), /empty subject/)
  assert.throws(() => parseKey('browser:profile:'), /empty segment/)
  assert.throws(() => parseKey(9222), /must be a string/)

  // v1 keys that are in the docs and in existing lock files must not explode.
  for (const key of ['dir:src/parser', 'repo:root']) {
    assert.equal(parseKey(key).known, false)
    assert.equal(canonicalKey(key), key)
    assert.equal(expandFacets(key).length, 1)
  }
  // `browser:chromium` is a KNOWN class with an opaque (v1-style) subject: it
  // expands to itself, compares by equality, and claims no containment.
  assert.equal(parseKey('browser:chromium').known, true)
  assert.deepEqual(expandFacets('browser:chromium'), ['browser:chromium'])
  assert.equal(parseKey('port:9222').known, true)
  assert.deepEqual(parseKey('browser:profile:work').qualifiers, ['work'])
})

/* ------------------------------------------------------------------ §2.1 */

test('§2.1 an unknown class is ACCEPTED as an opaque singleton, but a near miss WARNS', () => {
  // §2.1 (as revised): arbitrary resource names are legitimate, so an unknown
  // class is not a hard error -- but a MISSPELLED known class would silently stop
  // excluding the resource it was meant to protect, so that case must be loud.
  // The two live outcomes are pinned here, including that the warning really fires.
  const emitted = []
  const realEmit = process.emitWarning
  process.emitWarning = (message, type) => { emitted.push({ message: String(message), type: String(type) }) }
  try {
    // Unrelated name: accepted, and silent (it is a legal custom resource).
    assert.equal(canonicalKey('race:key'), 'race:key')
    assert.equal(parseKey('race:key').known, false)
    assert.equal(emitted.length, 0, `no warning for a legitimate custom name; got ${JSON.stringify(emitted)}`)

    // Observed spelling: still ACCEPTED (never a hard failure), but warned.
    for (const typo of ['paht:D:/out', 'prot:9222', 'porf:work']) {
      const parsed = parseKey(typo)
      assert.equal(parsed.known, false, `${typo}: accepted as opaque`)
      assert.equal(parsed.canonical, typo.toLowerCase(), `${typo}: canonical kept as-is (no folding)`)
    }
    assert.equal(emitted.length, 3, `one warning per distinct near-miss class; got ${JSON.stringify(emitted)}`)
    for (const row of emitted) {
      assert.equal(row.type, 'ResourceLeaseWarning')
      assert.match(row.message, /looks like a typo of/)
      // It must name the class it probably meant, or the warning is useless.
      assert.match(row.message, /"(path|port|proc):"/)
      assert.match(row.message, /will NOT conflict/)
    }
    // Repeat calls do not spam: one notice per class per process.
    parseKey('paht:D:/out')
    assert.equal(emitted.length, 3)
  } finally {
    process.emitWarning = realEmit
  }

  // An opaque near miss is NOT folded into its lookalike: still a distinct facet,
  // which is exactly why it has to warn (§2.1).
  assert.notEqual(canonicalKey('paht:D:/out'), canonicalKey('path:D:/out'))
  assert.equal(keysConflict('paht:D:/out', 'exclusive', 'path:D:/out', 'exclusive'), false)
})

/* ------------------------------------------------- §11 2, 3: path ancestry */

test('§11 #2 path:D:/out conflicts with path:D:/out/sub (ancestor)', () => {
  assert.equal(keysConflict('path:D:/out', 'exclusive', 'path:D:/out/sub', 'exclusive'), true)
  assert.equal(keysConflict('path:D:/out/sub', 'exclusive', 'path:D:/out', 'exclusive'), true)
  assert.equal(facetsConflict('path:d:/out', 'exclusive', 'path:d:/out/sub/deep', 'exclusive'), true)
})

test('§11 #3 path:D:/out does NOT conflict with path:D:/out2 (per-segment comparison)', () => {
  assert.equal(keysConflict('path:D:/out', 'exclusive', 'path:D:/out2', 'exclusive'), false)
  assert.equal(keysConflict('path:D:/out', 'exclusive', 'path:D:/outside', 'exclusive'), false)
  assert.equal(keysConflict('path:D:/out', 'exclusive', 'path:D:/output', 'exclusive'), false)
  // The v1 bug in one line: this is a raw string prefix, but not a segment prefix.
  assert.equal(facetsConflict('path:d:/out', 'exclusive', 'path:d:/out2', 'exclusive'), false)
})

test('§11 2/3: ancestor spans only through real separators, and roots contain everything', () => {
  assert.equal(keysConflict('path:D:/', 'exclusive', 'path:D:/anything/deep', 'exclusive'), true)
  assert.equal(keysConflict('path:/', 'exclusive', 'path:/usr', 'exclusive'), true)
  assert.equal(keysConflict('path:d:/out', 'exclusive', 'path:c:/out', 'exclusive'), false)
  assert.equal(keysConflict('path:/out', 'exclusive', 'path:/out/sub', 'exclusive'), true)
})

/* --------------------------------------- §11 4: browser facets (§3.1) */

test('§11 #4 browser:profile:work conflicts with its profile directory path', () => {
  // §3.3.1: the mapping is configuration. Explicit aliases come first.
  const aliases = { 'browser:profile:work': PROFILE_DIR }

  assert.deepEqual(expandFacets('browser:profile:work', aliases), [
    'browser:profile:work',
    PROFILE_DIR_CANONICAL,
  ])

  // Any spelling of the same directory collides, in both directions.
  assert.equal(keysConflict('browser:profile:work', 'exclusive', PROFILE_KEY, 'exclusive', aliases), true)
  assert.equal(keysConflict(PROFILE_KEY, 'exclusive', 'browser:profile:work', 'exclusive', aliases), true)
  // A sibling directory does not.
  assert.equal(
    keysConflict(
      'browser:profile:work',
      'exclusive',
      'path:C:/Users/x/AppData/Other',
      'exclusive',
      aliases,
    ),
    false,
  )
  // pathKey() is the supported way to turn a raw tool argument into a key.
  assert.equal(pathKey(PROFILE_DIR), PROFILE_DIR_CANONICAL)
  assert.equal(pathKey('C:/Users/X/AppData/Local/Google/Chrome/User Data/'), PROFILE_DIR_CANONICAL)
})

test('§3.3.1 no mapping means no expansion -- and that gap is OBSERVABLE', () => {
  // No mapping: only the key's own facet.
  assert.deepEqual(expandFacets('browser:profile:work'), ['browser:profile:work'])
  assert.equal(keysConflict('browser:profile:work', 'exclusive', PROFILE_KEY, 'exclusive'), false)

  // ... and the caller can SEE that it is unprotected instead of assuming it is.
  const missing = unresolvedAliases('browser:profile:work')
  assert.equal(missing.length, 1)
  assert.equal(missing[0].id, 'browser-profile-holds-path')
  assert.equal(missing[0].key, 'browser:profile:work')
  assert.ok(missing[0].hint.includes('browser:profile:'), 'a missing alias must say how to fix it')

  // expandReport() is the same information plus the facets.
  assert.deepEqual(expandReport('browser:profile:work'), {
    facets: ['browser:profile:work'],
    unresolved: missing,
  })

  // Once the alias exists, nothing is unresolved.
  assert.deepEqual(unresolvedAliases('browser:profile:work', { 'browser:profile:work': PROFILE_DIR }), [])
  // Keys that need no alias are never reported, and a resolved key stays silent.
  assert.deepEqual(unresolvedAliases('browser:cdp:9222'), [])
  assert.deepEqual(unresolvedAliases('path:D:/out'), [])
  assert.deepEqual(unresolvedAliases('port:9222'), [])
})

test('§3.3.1 alias priority: explicit > configured, and profileDirs still works', () => {
  setAliases({ 'browser:profile:work': PROFILE_DIR })
  setProfileDirs({ work: 'E:/from-profile-dirs', home: 'E:/home-dir' })
  try {
    // Configured aliases win over configured profileDirs for the same profile.
    assert.deepEqual(expandFacets('browser:profile:work'), [
      'browser:profile:work',
      PROFILE_DIR_CANONICAL,
    ])
    // Explicit beats configured.
    assert.deepEqual(expandFacets('browser:profile:work', { 'browser:profile:work': 'D:/explicit' }), [
      'browser:profile:work',
      'path:d:/explicit',
    ])
    // The legacy profileDirs channel still resolves a profile that has no alias.
    assert.deepEqual(expandFacets('browser:profile:home'), ['browser:profile:home', 'path:e:/home-dir'])
  } finally {
    setAliases(null)
    setProfileDirs(null)
  }
  assert.equal(getAliases(), null)
  assert.equal(getProfileDirs(), null)
})

test('§3.3.1 an alias may tie ANY key to a directory (repo:root -> the repo path)', () => {
  const aliases = { 'repo:root': 'D:\\Banking Buddy\\.dsh-im' }
  assert.deepEqual(expandFacets('repo:root', aliases), ['repo:root', 'path:d:/banking buddy/.dsh-im'])
  assert.equal(keysConflict('repo:root', 'exclusive', 'path:D:/Banking Buddy', 'exclusive', aliases), true)
  // Optional by design: a key without an alias is not an "unresolved" hole.
  assert.deepEqual(unresolvedAliases('repo:root'), [])
  // Alias keys are canonicalised, so a differently-cased alias key still matches.
  assert.deepEqual(expandFacets('repo:ROOT', { 'Repo:Root': 'E:/r' }), ['repo:root', 'path:e:/r'])
})

test('§3.1 browser:cdp:<port> occupies that port', () => {
  assert.deepEqual(expandFacets('browser:cdp:9222'), ['browser:cdp:9222', 'port:9222'])
  assert.equal(keysConflict('browser:cdp:9222', 'exclusive', 'port:9222', 'exclusive'), true)
  assert.equal(keysConflict('browser:cdp:9222', 'exclusive', 'port:9220-9230', 'exclusive'), true)
  assert.equal(keysConflict('browser:cdp:9222', 'exclusive', 'port:9333', 'exclusive'), false)
})

test('§3.2/§3.3 browser:instance is the container of every browser facet', () => {
  for (const other of ['browser:profile:work', 'browser:cdp:9222', 'browser:chromium']) {
    assert.equal(keysConflict('browser:instance', 'exclusive', other, 'exclusive'), true)
    assert.equal(keysConflict(other, 'exclusive', 'browser:instance', 'exclusive'), true)
  }
  // Two different profiles are independent resources.
  assert.equal(keysConflict('browser:profile:work', 'exclusive', 'browser:profile:home', 'exclusive'), false)
})

/* -------------------------------------------------- §11 5: port ranges */

test('§11 #5 port:9222 conflicts with port:9220-9230 (range overlap)', () => {
  assert.equal(keysConflict('port:9222', 'exclusive', 'port:9220-9230', 'exclusive'), true)
  assert.equal(keysConflict('port:9220-9230', 'exclusive', 'port:9222', 'exclusive'), true)
  assert.equal(keysConflict('port:9220-9230', 'exclusive', 'port:9235-9240', 'exclusive'), false)
  assert.equal(keysConflict('port:9220-9230', 'exclusive', 'port:9220', 'exclusive'), true)
  // Touching ranges share one port.
  assert.equal(keysConflict('port:9220-9230', 'exclusive', 'port:9230-9240', 'exclusive'), true)
})

/* --------------------------------------------- §11 10, 11: mode asymmetry */

test('§11 #10 shared + shared does not conflict', () => {
  assert.equal(facetsConflict('path:d:/out', 'shared', 'path:d:/out', 'shared'), false)
  assert.equal(keysConflict('port:9222', 'shared', 'port:9222', 'shared'), false)
})

test('§11 #11 shared + exclusive conflicts (in both directions)', () => {
  assert.equal(facetsConflict('path:d:/out', 'shared', 'path:d:/out', 'exclusive'), true)
  assert.equal(facetsConflict('path:d:/out', 'exclusive', 'path:d:/out', 'shared'), true)
  assert.equal(keysConflict('port:9222', 'shared', 'port:9222', 'exclusive'), true)
})

test('modes participate: same key, different modes, is the only thing that differs', () => {
  const key = 'path:d:/out'
  assert.equal(keysConflict(key, 'exclusive', key, 'exclusive'), true)
  assert.equal(keysConflict(key, 'exclusive', key, 'shared'), true)
  assert.equal(keysConflict(key, 'shared', key, 'shared'), false)
  // Absent mode means exclusive.
  assert.equal(facetsConflict('path:d:/out', undefined, 'path:d:/out', 'shared'), true)
  assert.equal(normalizeMode(undefined), 'exclusive')
  for (const mode of MODES) assert.equal(normalizeMode(mode.toUpperCase()), mode)
  assert.throws(() => normalizeMode('readwrite'), /mode must be one of/)
})

/* --------------------------------------- §3.3: screen:focus vs window:* */

test('§3.3 screen:focus does NOT conflict with window:*', () => {
  assert.equal(keysConflict('screen:focus', 'exclusive', 'window:hwnd:197772', 'exclusive'), false)
  assert.equal(keysConflict('window:hwnd:197772', 'exclusive', 'screen:focus', 'exclusive'), false)
  assert.equal(keysConflict('screen:focus', 'exclusive', 'window:hwnd:1', 'exclusive'), false)
  // ... which is exactly the point: focus still serialises, windows do not.
  assert.equal(keysConflict('screen:focus', 'exclusive', 'window:hwnd:2', 'exclusive'), false)
  assert.equal(keysConflict('screen:focus', 'exclusive', 'screen:focus', 'exclusive'), true)
  assert.equal(keysConflict('screen:pointer', 'exclusive', 'screen:pointer', 'exclusive'), true)
})

test('§3.3 the screen/window non-conflict is a documented table row, not luck', () => {
  const row = IMPLICATIONS.find((rule) => rule.id === 'screen-focus-is-not-a-window')
  assert.ok(row, 'the §3.3 no-conflict row must exist in IMPLICATIONS')
  assert.equal(row.kind, 'no-conflict')
  assert.equal(row.from.class, 'screen')
  assert.equal(row.from.subject, 'focus')
  assert.equal(row.conflictsWith.class, 'window')
  assert.ok(row.why.length > 20)
})

/* -------------------------------------------------- other class relations */

test('equal-subject classes conflict, unequal subjects do not', () => {
  assert.equal(keysConflict('window:hwnd:1', 'exclusive', 'window:hwnd:1', 'exclusive'), true)
  assert.equal(keysConflict('window:hwnd:1', 'exclusive', 'window:hwnd:2', 'exclusive'), false)
  assert.equal(keysConflict('proc:build', 'exclusive', 'proc:BUILD', 'exclusive'), true)
  assert.equal(keysConflict('proc:build', 'exclusive', 'proc:test', 'exclusive'), false)
  assert.equal(keysConflict('named:deploy', 'exclusive', 'named:deploy', 'exclusive'), true)
  assert.equal(keysConflict('api:openai:rpm', 'exclusive', 'api:openai:rpm', 'exclusive'), true)
  assert.equal(keysConflict('api:openai:rpm', 'exclusive', 'api:openai:tpm', 'exclusive'), false)
  assert.equal(keysConflict('api:openai:rpm', 'exclusive', 'api:anthropic:rpm', 'exclusive'), false)
})

test('different classes never conflict through subject comparison alone', () => {
  assert.equal(keysConflict('proc:d', 'exclusive', 'named:d', 'exclusive'), false)
  assert.equal(keysConflict('path:D:/9222', 'exclusive', 'port:9222', 'exclusive'), false)
  assert.equal(keysConflict('screen:focus', 'exclusive', 'named:focus', 'exclusive'), false)
})

/* ------------------------------------------- §3.4: the global total order */

test('§3.4 orderKey is the canonical class:subject:qualifiers string', () => {
  assert.equal(orderKey('path:D:/Out/'), 'path:d:/out')
  assert.equal(orderKey('browser:profile:work'), 'browser:profile:work')
  assert.equal(orderKey('port:09222'), 'port:9222')
})

test('§3.4 the order is TOTAL: distinct facets never share an order key', () => {
  const facets = [
    'browser:profile:a',
    'browser:profile:b',
    'browser:instance',
    'browser:cdp:9222',
    'path:d:/out',
    'path:d:/out2',
    'port:9222',
    'port:9220-9230',
    'proc:build',
    'proc:pid:1234',
    'screen:focus',
    'window:hwnd:1',
    'api:openai:rpm',
    'named:deploy',
  ]
  const keys = facets.map((facet) => orderKey(facet))
  assert.equal(new Set(keys).size, keys.length, 'order keys must be unique across distinct facets')
})

test('§3.4 compareFacets is a consistent, antisymmetric comparator', () => {
  assert.equal(compareFacets('path:d:/out', 'path:d:/out'), 0)
  assert.equal(compareFacets('api:openai:rpm', 'port:9222'), -1)
  assert.equal(compareFacets('port:9222', 'api:openai:rpm'), 1)
  // Prefix sorts first, which code-unit order gives for free.
  assert.equal(compareFacets('path:d:/out', 'path:d:/out/sub'), -1)
  assert.equal(compareFacets('path:d:/out/sub', 'path:d:/out'), 1)

  const sample = ['window:hwnd:1', 'browser:instance', 'path:d:/out', 'port:9222']
  for (const a of sample) {
    for (const b of sample) {
      const forward = Math.sign(compareFacets(a, b))
      const backward = Math.sign(compareFacets(b, a))
      assert.ok(forward === 0 ? backward === 0 : forward === -backward, `${a} vs ${b}`)
    }
  }
})

test('§3.4 compareFacets uses UTF-16 CODE UNIT order, not code points (astral case)', () => {
  // The review's reproduction. U+1F600 is astral, U+E000 is BMP:
  //   code POINT order  : U+E000 (57344) < U+1F600 (128512)
  //   code UNIT order   : the emoji's first surrogate D83D (55357) < E000, so the
  //                       emoji sorts FIRST.
  // PowerShell's [StringComparer]::Ordinal and Node's `<` are both code-unit order,
  // and the CLI sorts with CompareOrdinal, so code-unit is the only choice that
  // keeps the two implementations agreeing (§3.4 hard requirement 2). Sorting them
  // differently on two machines is the cross-machine deadlock G2 exists to prevent.
  const emoji = 'browser:profile:\u{1F600}'
  const bmp = 'browser:profile:\uE000'

  assert.equal(orderKey(emoji) < orderKey(bmp), true, 'JS "<" is code-unit order')
  assert.equal(compareFacets(emoji, bmp), -1, 'compareFacets must agree with "<"')
  assert.equal(compareFacets(bmp, emoji), 1, 'and it must be antisymmetric')
  assert.equal(Math.sign(compareFacets(emoji, bmp)), orderKey(emoji) < orderKey(bmp) ? -1 : 1)

  // Every pair of the same sample must agree with a plain JavaScript sort.
  const sample = [emoji, bmp, 'browser:profile:work', 'port:9222', 'path:d:/out']
  const byComparator = sample.slice().sort((a, b) => compareFacets(a, b))
  const byCodeUnit = sample.slice().sort((a, b) => {
    const left = orderKey(a)
    const right = orderKey(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
  assert.deepEqual(byComparator, byCodeUnit, 'the exported comparator must BE code-unit order')
  assert.deepEqual(sortFacets(sample), byCodeUnit, 'sortFacets follows the same order')
})

test('§3.4 sortFacets is stable, machine-independent and independent of request order', () => {
  const requested = ['port:9222', 'path:D:/Out', 'screen:focus', 'browser:profile:work']
  const one = sortFacets(requested)
  const two = sortFacets([...requested].reverse())
  assert.deepEqual(one, two)
  assert.deepEqual(one, ['browser:profile:work', 'path:d:/out', 'port:9222', 'screen:focus'])
  // Sorting is idempotent and does not mutate the input.
  assert.deepEqual(sortFacets(one), one)
  assert.equal(requested[0], 'port:9222')
})

/* ------------------------------------------------------- table integrity */

test('§3.3 implications live in exactly one table', () => {
  const ids = IMPLICATIONS.map((rule) => rule.id)
  assert.equal(new Set(ids).size, ids.length, 'implication ids must be unique')
  for (const rule of IMPLICATIONS) {
    assert.ok(['facet', 'containment', 'no-conflict'].includes(rule.kind))
    // An empty `from` pattern means "any key" (the generic alias row).
    const wildcard = Object.keys(rule.from).length === 0
    assert.ok(wildcard || CLASS_NAMES.includes(rule.from.class), `${rule.id}: from.class must be a real class`)
    if (rule.conflictsWith?.class) assert.ok(CLASS_NAMES.includes(rule.conflictsWith.class))
    assert.equal(typeof rule.why, 'string')
    assert.ok(rule.why.length > 20, `${rule.id}: every implication needs a rationale`)
    if (rule.kind === 'facet') assert.equal(typeof rule.facet, 'function')
    if (rule.unresolved) {
      assert.ok(['required', 'optional'].includes(rule.unresolved))
      // Only a REQUIRED row ever reaches the caller, so only it must be actionable.
      if (rule.unresolved === 'required') {
        assert.ok(
          typeof rule.hint === 'string' && rule.hint.length > 10,
          `${rule.id}: a required-but-missing row needs an actionable hint`,
        )
      }
    }
  }
  // The three positive relations of §3.3, plus the explicit non-relation of §3.3
  // and the generic alias row of §3.3.1.
  for (const id of [
    'browser-profile-holds-path',
    'browser-cdp-holds-port',
    'browser-instance-contains-browser',
    'screen-focus-is-not-a-window',
    'declared-alias-holds-path',
  ]) {
    assert.ok(ids.includes(id), `missing implication row: ${id}`)
  }
  // Only the profile row is REQUIRED to resolve: a profile without a directory is
  // an unprotected directory, while a key without an alias is normal.
  assert.equal(IMPLICATIONS.find((r) => r.id === 'browser-profile-holds-path').unresolved, 'required')
  assert.equal(IMPLICATIONS.find((r) => r.id === 'declared-alias-holds-path').unresolved, 'optional')
})

test('§2/§3 the CLASSES table is complete and self-consistent', () => {
  assert.deepEqual(Object.keys(CLASSES).sort(), [...CLASS_NAMES].sort())
  for (const name of CLASS_NAMES) {
    const entry = CLASSES[name]
    assert.equal(entry.name, name)
    assert.equal(typeof entry.canonical, 'function')
    assert.equal(typeof entry.subjectsConflict, 'function')
    assert.equal(typeof entry.expandFacets, 'function')
    assert.equal(typeof entry.summary, 'string')
    // Every class is reflexive under its own predicate.
    const sample = {
      path: 'path:d:/out',
      port: 'port:9222',
      proc: 'proc:build',
      browser: 'browser:profile:work',
      screen: 'screen:focus',
      window: 'window:hwnd:1',
      api: 'api:openai:rpm',
      named: 'named:x',
    }[name]
    assert.equal(entry.subjectsConflict(sample, sample), true, `${name} must conflict with itself`)
  }
})

test('CLASSES.*.subjectsConflict accepts facet strings directly', () => {
  assert.equal(CLASSES.path.subjectsConflict('path:d:/out', 'path:d:/out/sub'), true)
  assert.equal(CLASSES.path.subjectsConflict('path:d:/out', 'path:d:/out2'), false)
  assert.equal(CLASSES.port.subjectsConflict('port:9222', 'port:9220-9230'), true)
  assert.equal(CLASSES.window.subjectsConflict('window:1', 'window:hwnd:1'), true)
})

/* -------------------------------------------------- conflicts reporting */

test('findConflicts reports every colliding facet pair (for §4.3 diagnostics)', () => {
  const aliases = { 'browser:profile:work': PROFILE_DIR }
  const toEntries = (facets) => facets.map((facet) => ({ facet, mode: 'exclusive' }))

  // SEMANTICS: the two lists are crossed, not merged. A list is one request's own
  // facet set, so a conflict inside one list is not reported by this function.
  const held = toEntries(expandFacets('browser:profile:work', aliases))
  const wanted = toEntries(expandFacets('path:D:/out', aliases))
  assert.deepEqual(findConflicts(held, wanted, aliases), [])
  assert.deepEqual(findConflicts(held, [], aliases), [], 'an empty side has no conflicts')

  // The held profile collides with the directory through the shared path facet,
  // including with a differently-spelled request for the same directory.
  const clash = toEntries(expandFacets('path:C:/Users/X/AppData/Local/Google/Chrome/User Data', aliases))
  assert.deepEqual(findConflicts(held, clash, aliases), [
    { facet: PROFILE_DIR_CANONICAL, otherFacet: PROFILE_DIR_CANONICAL },
  ])

  // Mode still decides: two shared readers of the same directory never collide.
  const sharedReaders = [{ facet: PROFILE_DIR_CANONICAL, mode: 'shared' }]
  assert.deepEqual(
    findConflicts(sharedReaders, [{ facet: PROFILE_DIR_CANONICAL, mode: 'shared' }], aliases),
    [],
  )
  assert.equal(
    findConflicts(sharedReaders, [{ facet: PROFILE_DIR_CANONICAL, mode: 'exclusive' }], aliases).length,
    1,
  )
})

test('facetsConflict throws on an unparseable facet instead of silently allowing', () => {
  assert.throws(() => facetsConflict('port:', 'exclusive', 'port:9222', 'exclusive'), /empty subject/)
  assert.throws(() => facetsConflict('port:9222', 'exclusive', 'nope', 'exclusive'), /not a resource key/)
})

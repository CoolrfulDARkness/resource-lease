/**
 * dsh-resource-lease -- the resource ALGEBRA (RESOURCE-MODEL-v2 §2 and §3).
 *
 * This module is the single definition of:
 *   - the key grammar and the canonical form that judges equality   (§2)
 *   - the CLASSES table: per-class canonical subject + subject predicate
 *   - the IMPLICATIONS table: every cross-class / containment relation (§3.3)
 *   - facet expansion, so two spellings of one resource collide          (§3.1)
 *   - the conflict predicate over (facet, mode) pairs                    (§3.2)
 *   - the global total order used to sort multi-key acquisition          (§3.4)
 *
 * ZERO dependencies outside `node:process`, and NO filesystem access: every
 * export here is a pure function of its arguments. A relative path is a HARD
 * ERROR (§2) unless the caller passed an explicit `base` -- `process.cwd()` is
 * only ever consulted by pathKey(), the one entry point whose job is to turn a
 * bare path into a key. `lock.js` owns the filesystem; this file never touches it.
 *
 * The four things that are easy to get wrong, and how each is handled here:
 *
 *   1. PATH ANCESTRY IS PER SEGMENT. `d:/out` and `d:/out2` do NOT conflict;
 *      `d:/out` and `d:/out/sub` do. A bare `a.startsWith(b)` is the v1 bug.
 *      See pathSubjectsConflict() / splitCanonicalPath().
 *   2. `screen:focus` DOES NOT CONFLICT WITH `window:*`. Focus is an input
 *      stream, a window is a target object; mixing them over-serialises. The
 *      decision is an explicit row in IMPLICATIONS (kind: 'no-conflict'), not an
 *      accident of two classes never sharing a facet.
 *   3. MODE PARTICIPATES: shared+shared is not a conflict, everything else is.
 *      `facetsConflict` is the only place that decides this.
 *   4. Every implication lives in IMPLICATIONS. Adding a resource class or a
 *      cross-class relation means editing that table, never a function branch.
 *   5. FACET EXPANSION HAS A DATA SOURCE (§3.3.1): the profile-name -> directory
 *      mapping is configuration, so it is passed in or configured, never guessed.
 *      A key that cannot expand says so -- unresolvedAliases() -- because a silent
 *      non-expansion means the caller believes a directory is protected when it is
 *      not.
 */

import process from 'node:process'

/**
 * The eight classes of §2, in the contract's order. A key whose class is not in
 * this list is still ACCEPTED, but only as an opaque class (see OPAQUE_CLASS):
 * v1 keys such as `dir:src/parser` and `repo:root` are in the wild and in the
 * tool description, and rejecting them would break existing callers. An opaque
 * class compares by exact canonical equality, expands to itself only, and never
 * silently claims a conflict it cannot know about.
 */
export const CLASS_NAMES = Object.freeze([
  'path',
  'port',
  'proc',
  'browser',
  'screen',
  'window',
  'api',
  'named',
])

/** Arbitration modes. Only 'shared' + 'shared' is exempt from conflict (§3.2). */
export const MODES = Object.freeze(['exclusive', 'shared', 'pool'])

/** The only metrics of an `api:<provider>:<metric>` key (§2). */
export const API_METRICS = Object.freeze(['rpm', 'tpm', 'concurrent'])

/** Modes that may coexist on one facet. Literally §3.2: shared vs shared. */
const COMPATIBLE_MODES = Object.freeze(['shared'])

/* ======================================================================== */
/* small string helpers                                                     */
/* ======================================================================== */

/**
 * Join a class, a canonical subject and canonical qualifiers into the canonical
 * key string. Every canonical form in this module goes through this one join, so
 * a key cannot be spelled two ways internally.
 *
 * @param {string} cls canonical class.
 * @param {string} subject canonical subject (may itself contain ':' for `path`).
 * @param {readonly string[]} qualifiers canonical qualifiers.
 * @returns {string} canonical key.
 */
function joinKey(cls, subject, qualifiers) {
  return qualifiers.length === 0 ? `${cls}:${subject}` : `${cls}:${subject}:${qualifiers.join(':')}`
}

/**
 * Compare two canonical string lists element-wise.
 *
 * @param {readonly string[]} a first list.
 * @param {readonly string[]} b second list.
 * @returns {boolean} true when both lists are element-wise identical.
 */
function sameStrings(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * Strip leading zeros from a decimal string without going through Number, so a
 * 20-digit hardware id keeps every digit instead of losing its tail to float
 * precision.
 *
 * @param {string} text candidate decimal string.
 * @returns {string} decimal string, no leading zeros.
 */
function basicallyDecimal(text) {
  const trimmed = String(text).replace(/^0+(?=\d)/, '')
  return trimmed === '' ? '0' : trimmed
}

/**
 * Canonical decimal from a string, rejecting anything that is not digits.
 *
 * @param {string} text candidate decimal string.
 * @param {string} what human-readable field name for the error message.
 * @returns {string} canonical decimal.
 */
function requireDecimal(text, what) {
  if (!/^\d+$/.test(text)) {
    throw new Error(`resource lease: ${what} must be a decimal integer (got "${text}")`)
  }
  return basicallyDecimal(text)
}

/* ======================================================================== */
/* path canonicalisation (§2 `path` row)                                    */
/* ======================================================================== */

/**
 * Whether a backslash-normalised, lowercased string is rooted.
 *
 * `d:out` passes this test (it starts with a drive letter) but canonicalPath()
 * still REJECTS it: it is drive-relative, so it depends on the caller's working
 * directory. Only `/...`, `//...` and `d:/...` are usable spellings.
 *
 * @param {string} s normalised candidate.
 * @returns {boolean} true when the path is rooted.
 */
function isAbsolutePathText(s) {
  return s.startsWith('/') || /^[a-z]:/.test(s)
}

/**
 * Split a canonical path into its root and its segments.
 *
 * Roots: '' (POSIX, rendered as '/'), 'd:' (drive), '//server/share' (UNC).
 *
 * @param {string} s canonical path.
 * @returns {{ root: string, parts: string[] }} root plus path segments.
 */
function splitCanonicalPath(s) {
  if (s.startsWith('//')) {
    const segments = s.slice(2).split('/').filter((x) => x !== '')
    return { root: `//${segments.slice(0, 2).join('/')}`, parts: segments.slice(2) }
  }
  if (/^[a-z]:/.test(s)) {
    return { root: s.slice(0, 2), parts: s.slice(2).split('/').filter((x) => x !== '') }
  }
  return { root: '', parts: s.slice(1).split('/').filter((x) => x !== '') }
}

/**
 * Resolve `.` and `..` over a segment list. `..` never climbs above the root,
 * which is what every filesystem does and what keeps the canonical form stable.
 *
 * @param {string[]} segments raw segments.
 * @param {string[]} start segments already resolved (the base for a relative path).
 * @returns {string[]} resolved segments.
 */
function resolveSegments(segments, start) {
  const parts = start.slice()
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts
}

/**
 * Render a root plus segments back to the canonical form. Trailing separators are
 * dropped, except on a root: `d:/` and `/` keep their slash so a root is
 * distinguishable from the (invalid) empty path.
 *
 * @param {string} root one of the roots produced by splitCanonicalPath().
 * @param {string[]} parts resolved segments.
 * @returns {string} canonical path.
 */
function joinCanonicalPath(root, parts) {
  const tail = parts.join('/')
  if (root === '') return tail === '' ? '/' : `/${tail}`
  if (root.startsWith('//')) return tail === '' ? root : `${root}/${tail}`
  return `${root}/${tail}`
}

/**
 * Split an ABSOLUTE, already backslash-normalised + lowercased string into
 * root and resolved segments.
 *
 * @param {string} s absolute normalised path.
 * @returns {{ root: string, parts: string[] }} root plus resolved segments.
 */
function splitAbsolutePath(s) {
  if (s.startsWith('//')) {
    const segments = s.slice(2).split('/').filter((x) => x !== '' && x !== '.')
    return { root: `//${segments.slice(0, 2).join('/')}`, parts: resolveSegments(segments.slice(2), []) }
  }
  if (/^[a-z]:/.test(s)) {
    return { root: s.slice(0, 2), parts: resolveSegments(s.slice(2).split('/'), []) }
  }
  return { root: '', parts: resolveSegments(s.slice(1).split('/'), []) }
}

/**
 * Normalise one filesystem path into the canonical `path` subject (§2):
 * absolute, forward slashes, lowercase drive letter, lowercase whole string,
 * `.`/`..` resolved, trailing separator dropped (root excepted).
 *
 * Deliberately does NOT resolve symlinks: that would introduce a TOCTOU window
 * between "canonicalise" and "use", which §10 rules out. Two agents pointing at
 * the same file through different symlinks are an acknowledged blind spot (§8).
 *
 * A RELATIVE path is a hard error unless the caller supplied an explicit `base`
 * (§2): resolving it against `process.cwd()` would make the canonical form depend
 * on where the caller happened to run, so two agents in different directories
 * would hold two different locks for ONE directory and exclusion would fail
 * silently -- the one failure mode this module exists to prevent. A `c:out`
 * drive-relative spelling is rejected for the same reason: it is cwd-dependent
 * too. `pathKey()` is the supported entry point for a bare path (it resolves the
 * caller's path itself); a `path:` KEY must be absolute.
 *
 * @param {unknown} input path in any spelling.
 * @param {{ base?: string }} [options] base for a relative path; REQUIRED for one.
 * @returns {string} canonical path subject.
 */
export function canonicalPath(input, options = {}) {
  const opts = optionsFrom(options)
  const raw = String(input ?? '').trim()
  if (raw === '') throw new Error('resource lease: a path must not be empty')
  const s = raw.replace(/\\/g, '/').toLowerCase()
  if (isAbsolutePathText(s)) {
    // `c:out` / `c:` -- rooted on a drive but still relative to the caller's
    // working directory on that drive. Guessing "c:/out" would be exactly the
    // silent cwd dependency §2 forbids (the CLI rejects it as exit 3).
    if (!s.startsWith('/') && !/^[a-z]:\//.test(s)) {
      throw new Error(
        `resource lease: "${String(input)}" is drive-relative; write an absolute path `
        + `(e.g. "d:/out", not "d:out")`,
      )
    }
    const { root, parts } = splitAbsolutePath(s)
    return joinCanonicalPath(root, parts)
  }
  const baseText = typeof opts.base === 'string' ? opts.base.trim().replace(/\\/g, '/').toLowerCase() : ''
  if (baseText === '') {
    throw new Error(
      `resource lease: "${String(input)}" is a relative path, and a path key must be ABSOLUTE `
      + '(e.g. path:D:/out). A relative path would make the canonical form depend on the '
      + "caller's working directory, so two agents in different directories would hold two "
      + 'different locks for one directory and exclusion would fail silently (§2). '
      + 'Resolve it first (path.resolve, or pathKey() which accepts a bare path), '
      + 'or pass an explicit { base }.',
    )
  }
  if (!isAbsolutePathText(baseText)) {
    throw new Error(`resource lease: base "${String(opts.base)}" must itself be absolute`)
  }
  const baseSplit = splitAbsolutePath(baseText)
  return joinCanonicalPath(baseSplit.root, resolveSegments(s.split('/'), baseSplit.parts))
}

/**
 * Whether one canonical segment list is a prefix of the other (ancestor test).
 *
 * @param {readonly string[]} a first segment list.
 * @param {readonly string[]} b second segment list.
 * @returns {boolean} true when a is b or an ancestor of b.
 */
function isSegmentPrefix(a, b) {
  if (a.length > b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * §3.2 `path` row: equal, or one is an ancestor of the other, compared SEGMENT BY
 * SEGMENT. This is the v1 bug: `d:/out` vs `d:/out2` share a string prefix but no
 * segment prefix, so they do not conflict; `d:/out` vs `d:/out/sub` do.
 *
 * @param {{ subject: string }} a canonical path facet.
 * @param {{ subject: string }} b canonical path facet.
 * @returns {boolean} true when the paths overlap.
 */
function pathSubjectsConflict(a, b) {
  if (a.subject === b.subject) return true
  const pa = splitCanonicalPath(a.subject)
  const pb = splitCanonicalPath(b.subject)
  if (pa.root !== pb.root) return false
  return isSegmentPrefix(pa.parts, pb.parts) || isSegmentPrefix(pb.parts, pa.parts)
}

/* ======================================================================== */
/* port canonicalisation and overlap (§2 / §3.1 / §3.2 `port` row)          */
/* ======================================================================== */

/**
 * Parse a port subject: `9222` or `9220-9230` (§2).
 *
 * @param {string} text port or range spelling.
 * @returns {{ lo: number, hi: number }} inclusive bounds.
 */
function parsePortSpec(text) {
  const cleaned = String(text).replace(/\s+/g, '')
  const match = /^(\d+)(?:-(\d+))?$/.exec(cleaned)
  if (!match) {
    throw new Error(
      `resource lease: "${text}" is not a port or a port range; write port:9222 or port:9220-9230`,
    )
  }
  const lo = Number(match[1])
  const hi = match[2] === undefined ? lo : Number(match[2])
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) {
    throw new Error(`resource lease: "${text}" is not a usable port number`)
  }
  if (lo < 0 || hi > 65535) {
    throw new Error(`resource lease: "${text}" is outside the port range 0-65535`)
  }
  if (lo > hi) {
    throw new Error(`resource lease: "${text}" must be written lo-hi with lo <= hi`)
  }
  return { lo, hi }
}

/**
 * Canonical port subject: no leading zeros; a degenerate range collapses to a
 * single port (`9222-9222` -> `9222`) so one resource has one spelling.
 *
 * @param {string} text port spelling.
 * @returns {string} canonical port subject.
 */
function canonicalPortSubject(text) {
  const { lo, hi } = parsePortSpec(text)
  return lo === hi ? String(lo) : `${lo}-${hi}`
}

/**
 * §3.2 `port` row: single values are equal, ranges overlap.
 *
 * @param {{ subject: string }} a canonical port facet.
 * @param {{ subject: string }} b canonical port facet.
 * @returns {boolean} true when the port sets intersect.
 */
function portSubjectsConflict(a, b) {
  const pa = parsePortSpec(a.subject)
  const pb = parsePortSpec(b.subject)
  return pa.lo <= pb.hi && pb.lo <= pa.hi
}

/* ======================================================================== */
/* the IMPLICATIONS table (§3.3)                                            */
/* ======================================================================== */

/**
 * EVERY relation that is not "same class, compare subjects" lives here. Adding a
 * resource class or a cross-class collision means adding a row, not a branch in
 * some function (§3.3: "no scattering across call sites").
 *
 * Row shapes:
 *
 *   { kind: 'facet', from, facet(parsed, options) -> string | null }
 *     The key also OCCUPIES the returned facet. This is how two different
 *     spellings of one resource collide (§3.1): the facet sets intersect and the
 *     ordinary same-class subject predicate decides. A `null` result means "not
 *     resolvable here"; whether that is a problem is declared by `unresolved`.
 *
 *   { kind: 'containment', from, conflictsWith }
 *     `from` is a container: it collides with every facet matching
 *     `conflictsWith`, whatever the subject. Consulted by CLASSES.browser.
 *
 *   { kind: 'no-conflict', from, conflictsWith }
 *     An explicit NON-relation. Documented here so nobody "helpfully" adds it
 *     later, and enforced as a veto inside facetsConflict().
 *
 * `unresolved: 'required'` marks a row whose missing data is a real hole in the
 * caller's protection (§3.3.1: it must be observable, never silent). `'optional'`
 * rows are silent by design, because most keys legitimately have no alias.
 *
 * An empty `from` pattern matches every key.
 *
 * @type {ReadonlyArray<{
 *   id: string,
 *   kind: 'facet' | 'containment' | 'no-conflict',
 *   from: { class?: string, subject?: string },
 *   conflictsWith?: { class?: string, subject?: string },
 *   facet?: (parsed: object, options: object) => string | null,
 *   unresolved?: 'required' | 'optional',
 *   hint?: string,
 *   why: string,
 * }>}
 */
export const IMPLICATIONS = Object.freeze([
  Object.freeze({
    id: 'declared-alias-holds-path',
    kind: 'facet',
    from: Object.freeze({}),
    facet: (parsed, options) => {
      const dir = resolveAlias(parsed, options)
      return dir === null ? null : `path:${canonicalPath(dir, options)}`
    },
    unresolved: 'optional',
    why: '§3.3.1: an alias may tie ANY key to a directory (repo:root -> the repo path, dir:src/parser -> src/parser). Configured, not guessed, so an unknown key stays silent instead of inventing a conflict.',
  }),
  Object.freeze({
    id: 'browser-profile-holds-path',
    kind: 'facet',
    from: Object.freeze({ class: 'browser', subject: 'profile' }),
    facet: (parsed, options) => {
      const dir = resolveAlias(parsed, options)
      return dir === null ? null : `path:${canonicalPath(dir, options)}`
    },
    unresolved: 'required',
    hint: 'Alias browser:profile:<name> to its directory (aliases option / setAliases / profileDirs), or declare path:<dir> directly. Until then two agents can hold this profile and its directory at the same time.',
    why: 'Two agents on one browser profile share one on-disk profile directory. Whoever declares the raw path and whoever declares browser:profile:<name> must collide (§3.1).',
  }),
  Object.freeze({
    id: 'browser-cdp-holds-port',
    kind: 'facet',
    from: Object.freeze({ class: 'browser', subject: 'cdp' }),
    facet: (parsed) => `port:${parsed.qualifiers[0]}`,
    unresolved: 'optional',
    why: 'A CDP endpoint IS a listening port. browser:cdp:9222 and port:9222 must collide, otherwise one agent binds a port another thinks it owns (§3.1).',
  }),
  Object.freeze({
    id: 'browser-instance-contains-browser',
    kind: 'containment',
    from: Object.freeze({ class: 'browser', subject: 'instance' }),
    conflictsWith: Object.freeze({ class: 'browser' }),
    why: 'browser:instance is the container of the whole browser: closing or relaunching it invalidates any profile/cdp/legacy subject under it (§3.2 and §3.3; §3.3 says "all browser:*", which is the broader and intended reading).',
  }),
  Object.freeze({
    id: 'screen-focus-is-not-a-window',
    kind: 'no-conflict',
    from: Object.freeze({ class: 'screen', subject: 'focus' }),
    conflictsWith: Object.freeze({ class: 'window' }),
    why: 'Focus is an input stream, a window is a target object. Two agents may own different windows while both needing focus; serialising the two classes would over-serialise every window operation behind focus (§3.3 explicitly forbids this conflict).',
  }),
])

/* ======================================================================== */
/* alias resolution -- the data source of facet expansion (§3.3.1)           */
/* ======================================================================== */

/**
 * Aliases map a resource key to the path it occupies, e.g.
 * `{ "browser:profile:work": "C:/Users/x/.../User Data" }`. The mapping is
 * machine-specific, so it is CONFIGURATION, never a hard-coded guess (§3.3.1).
 *
 * Priority (§3.3.1): explicit `aliases` option > explicit `profileDirs` option >
 * configured aliases > configured profile dirs > no expansion.
 *
 * @type {Record<string, string> | null}
 */
let configuredAliases = null

/**
 * Configure process-wide aliases (§3.3.1 source 2: "the plugin config's aliases").
 *
 * @param {Record<string, string> | null} aliases key -> path map; `null` clears.
 */
export function setAliases(aliases) {
  configuredAliases = aliases ?? null
}

/** @returns {Record<string, string> | null} the configured key -> path aliases. */
export function getAliases() {
  return configuredAliases
}

/**
 * Backwards-compatible configuration: profile NAME -> directory, the shape the
 * profile row used before §3.3.1 existed.
 *
 * @type {Record<string, string> | ((name: string) => string | null | undefined) | null}
 */
let defaultProfileDirs = null

/**
 * Configure the default profile directory mapping (process-wide).
 *
 * @param {Record<string, string> | ((name: string) => string | null | undefined) | null} dirs
 *   object map or resolver function; `null` clears it.
 */
export function setProfileDirs(dirs) {
  defaultProfileDirs = dirs ?? null
}

/** @returns {Record<string, string> | ((name: string) => string) | null} current default. */
export function getProfileDirs() {
  return defaultProfileDirs
}

/** The option names a caller may pass as the second argument of a public call. */
const OPTION_KEYS = Object.freeze(['aliases', 'profileDirs', 'base'])

/**
 * Accept either the §3.3.1 shape (`expandFacets(key, aliasesTable)`) or an options
 * object (`{ aliases, profileDirs, base }`).
 *
 * A table of aliases is distinguished from an options object by its fields. This
 * is safe because an alias key is a resource key ("browser:profile:work") and
 * therefore never collides with an option name.
 *
 * @param {unknown} arg second argument of any public function.
 * @returns {{ aliases?: Record<string, string>, profileDirs?: object | Function, base?: string }} options.
 */
function optionsFrom(arg) {
  if (arg === undefined || arg === null || typeof arg !== 'object') return {}
  for (const key of OPTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(arg, key)) return arg
  }
  // Bare alias table (§3.3.1 signature): every field is "key -> path".
  return { aliases: /** @type {Record<string, string>} */ (arg) }
}

/**
 * Look one key up in an alias table. Keys are canonicalised on lookup, so
 * `{ "Browser:Profile:Work": ... }` and the canonical spelling are equivalent.
 *
 * @param {unknown} table alias table.
 * @param {string} canonical canonical key to find.
 * @returns {string | null} path spelling, or null.
 */
function lookupAlias(table, canonical) {
  if (table === undefined || table === null) return null
  if (typeof table === 'function') {
    const direct = table(canonical)
    return typeof direct === 'string' && direct.trim() !== '' ? direct : null
  }
  if (typeof table !== 'object') return null
  for (const [rawKey, value] of Object.entries(table)) {
    if (typeof value !== 'string' || value.trim() === '') continue
    let key
    try {
      key = canonicalKey(rawKey)
    } catch {
      // An unusable alias key cannot match anything; ignore just that entry.
      continue
    }
    if (key === canonical) return value
  }
  return null
}

/**
 * Look one profile name up in a name -> directory map.
 *
 * @param {unknown} table name -> directory map or resolver function.
 * @param {string} name canonical profile name.
 * @returns {string | null} directory spelling, or null.
 */
function lookupProfileDir(table, name) {
  if (table === undefined || table === null) return null
  if (typeof table === 'function') {
    const direct = table(name)
    return typeof direct === 'string' && direct.trim() !== '' ? direct : null
  }
  if (typeof table !== 'object') return null
  const value = table[name] ?? table[String(name).toLowerCase()]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Resolve the path a key aliases to, using the §3.3.1 priority order.
 *
 * @param {{ canonical: string, class: string, subject: string, qualifiers: readonly string[] }} parsed
 *   canonical parse of the key.
 * @param {object} options normalised options.
 * @returns {string | null} path spelling, or null when nothing is configured.
 */
function resolveAlias(parsed, options = {}) {
  const direct = lookupAlias(options.aliases, parsed.canonical) ?? lookupAlias(configuredAliases, parsed.canonical)
  if (direct !== null) return direct
  if (parsed.class === 'browser' && parsed.subject === 'profile') {
    const name = parsed.qualifiers[0]
    return lookupProfileDir(options.profileDirs, name) ?? lookupProfileDir(defaultProfileDirs, name)
  }
  return null
}


/* ======================================================================== */
/* transparent per-class canonical subjects                                 */
/* ======================================================================== */

/**
 * Pass a rough parse through unchanged (subject/qualifiers already lowercased).
 *
 * @param {{ subject: string, qualifiers: string[] }} rough rough parse.
 * @returns {{ subject: string, qualifiers: string[] }} canonical parts.
 */
function passthroughParts(rough) {
  return { subject: rough.subject, qualifiers: rough.qualifiers }
}

/**
 * Require that a fixed subject carries no qualifiers (`screen:focus:x` is a typo,
 * and silently accepting it would create a second, non-colliding spelling).
 *
 * @param {{ subject: string, qualifiers: string[] }} rough rough parse.
 * @returns {{ subject: string, qualifiers: string[] }} canonical parts.
 */
function fixedSubjectParts(rough) {
  if (rough.qualifiers.length !== 0) {
    throw new Error(
      `resource lease: ${rough.class}:${rough.subject} takes no qualifier (got "${rough.qualifiers.join(':')}")`,
    )
  }
  return passthroughParts(rough)
}

/**
 * Compare two parsed facets by canonical subject and qualifiers (the `equal`
 * rows of §3.2 and the opaque-class rule).
 *
 * @param {object} a parsed facet.
 * @param {object} b parsed facet.
 * @returns {boolean} true when both name the same subject.
 */
function sameSubject(a, b) {
  return a.subject === b.subject && sameStrings(a.qualifiers, b.qualifiers)
}

/**
 * Accept either a facet string or an already-parsed facet.
 *
 * @param {string | object} facet facet string or parsed facet.
 * @param {object} [options] parse options, used for strings.
 * @returns {object} parsed facet.
 */
function asFacet(facet, options = {}) {
  return typeof facet === 'string' ? parseKey(facet, options) : facet
}

/**
 * Whether a parsed facet matches a table pattern.
 *
 * @param {object} parsed parsed facet.
 * @param {{ class?: string, subject?: string }} pattern pattern; absent fields match anything.
 * @returns {boolean} true when the pattern applies.
 */
function matchesPattern(parsed, pattern) {
  if (!pattern) return false
  if (pattern.class !== undefined && parsed.class !== pattern.class) return false
  if (pattern.subject !== undefined && parsed.subject !== pattern.subject) return false
  return true
}

/**
 * Find the first IMPLICATIONS row of a kind that relates the two facets, in
 * either direction.
 *
 * @param {'facet' | 'containment' | 'no-conflict'} kind row kind.
 * @param {object} a parsed facet.
 * @param {object} b parsed facet.
 * @returns {object | null} matching row, or null.
 */
function tableRule(kind, a, b) {
  for (const rule of IMPLICATIONS) {
    if (rule.kind !== kind) continue
    if (matchesPattern(a, rule.from) && matchesPattern(b, rule.conflictsWith)) return rule
    if (matchesPattern(b, rule.from) && matchesPattern(a, rule.conflictsWith)) return rule
  }
  return null
}

/**
 * The extra facets a key occupies, per the `kind: 'facet'` rows -- plus the rows
 * that could NOT resolve, so §3.3.1's "never silently unexpanded" rule holds.
 *
 * @param {object} parsed canonical parse of the key.
 * @param {object} options normalised options (aliases, profileDirs, base).
 * @returns {{ facets: string[], unresolved: Array<{ id: string, key: string, hint: string }> }}
 *   derived facets (deduplicated, table order) and the required-but-missing rows.
 */
function derivedFacetsReport(parsed, options = {}) {
  const facets = []
  const unresolved = []
  for (const rule of IMPLICATIONS) {
    if (rule.kind !== 'facet') continue
    if (rule.from.class !== undefined && rule.from.class !== parsed.class) continue
    if (!matchesPattern(parsed, rule.from)) continue
    const facet = rule.facet(parsed, options)
    if (typeof facet === 'string' && facet !== '') {
      if (!facets.includes(facet)) facets.push(facet)
      continue
    }
    if (rule.unresolved === 'required') {
      unresolved.push({ id: rule.id, key: parsed.canonical, hint: rule.hint ?? '' })
    }
  }
  return { facets, unresolved }
}

/* ======================================================================== */
/* the CLASSES table (§2 canonical form + §3.2 subject predicates)          */
/* ======================================================================== */

/**
 * Build one CLASSES entry. `parts` is the single source of truth for the
 * canonical form; `canonical()` just joins it.
 *
 * @param {string} name class name.
 * @param {{ summary: string, parts: Function, subjectsConflict: Function }} spec class spec.
 * @returns {object} frozen class entry.
 */
function defineClass(name, spec) {
  const partsOf = spec.parts
  return Object.freeze({
    name,
    summary: spec.summary,
    /** Rough parse (or canonical parse) -> canonical subject + qualifiers. Idempotent. */
    parts: partsOf,
    /** Canonical key string for this class. */
    canonical: (parsed, options = {}) => {
      const { subject, qualifiers } = partsOf(parsed, options)
      return joinKey(name, subject, qualifiers)
    },
    /** §3.2 subject predicate; accepts facet strings or parsed facets. */
    subjectsConflict: (a, b, options = {}) =>
      spec.subjectsConflict(asFacet(a, optionsFrom(options)), asFacet(b, optionsFrom(options))),
    /** Extra facets this class occupies (§3.1), excluding the key itself. */
    expandFacets: (parsed, options = {}) => derivedFacetsReport(parsed, optionsFrom(options)).facets,
  })
}

/**
 * Per-class canonicalisation and subject predicates (§2, §3.2).
 *
 * @type {Readonly<Record<string, object>>}
 */
export const CLASSES = Object.freeze({
  path: defineClass('path', {
    summary: 'A filesystem path. Ancestry is decided per segment, never by string prefix.',
    parts: (rough, options) => ({ subject: canonicalPath(rough.subject, options), qualifiers: [] }),
    subjectsConflict: pathSubjectsConflict,
  }),

  port: defineClass('port', {
    summary: 'A TCP port, or an inclusive lo-hi range. Ranges conflict when they overlap.',
    parts: (rough) => ({ subject: canonicalPortSubject(rough.subject), qualifiers: [] }),
    subjectsConflict: portSubjectsConflict,
  }),

  proc: defineClass('proc', {
    summary: 'A job name (proc:<job>) or one concrete PID (proc:pid:<n>). Equality only.',
    parts: (rough) => {
      if (rough.subject === 'pid') {
        if (rough.qualifiers.length !== 1) {
          throw new Error('resource lease: proc:pid needs exactly one PID; write proc:pid:1234')
        }
        return { subject: 'pid', qualifiers: [requireDecimal(rough.qualifiers[0], 'a proc:pid PID')] }
      }
      return passthroughParts(rough)
    },
    subjectsConflict: sameSubject,
  }),

  browser: defineClass('browser', {
    summary: 'browser:instance (the container), browser:profile:<name>, browser:cdp:<port>, browser:origin:<host>, or a legacy opaque subject.',
    parts: (rough) => {
      if (rough.subject === 'instance') {
        return { subject: 'instance', qualifiers: [] }
      }
      if (rough.subject === 'profile') {
        if (rough.qualifiers.length !== 1) {
          throw new Error(
            'resource lease: browser:profile needs exactly one profile name; write browser:profile:work',
          )
        }
        return { subject: 'profile', qualifiers: [rough.qualifiers[0]] }
      }
      if (rough.subject === 'cdp') {
        if (rough.qualifiers.length !== 1) {
          throw new Error('resource lease: browser:cdp needs exactly one port; write browser:cdp:9222')
        }
        return { subject: 'cdp', qualifiers: [canonicalPortSubject(rough.qualifiers[0])] }
      }
      if (rough.subject === 'origin') {
        // One writer per origin. Different hosts do NOT conflict, which is the
        // point: sharding agents by site turns "parallel writes" from unsafe
        // into safe, because they no longer share server-side state. Two
        // agents on the SAME origin still conflict, because a shared target
        // has a read-modify-write window no browser-side scheme can close.
        //
        // Everything after `origin:` is one value, not colon-separated parts:
        // callers paste URLs, and a scheme contains a colon.
        const raw = rough.qualifiers.join(':')
        const host = raw
          .trim()
          .toLowerCase()
          .replace(/^[a-z]+:\/\//, '')
          .replace(/\/.*$/, '')
          .replace(/\.$/, '')
        if (host === '' || host.includes('/') || /\s/.test(host)) {
          throw new Error(
            `resource lease: "${raw}" is not an origin host; write browser:origin:zhihu.com`,
          )
        }
        return { subject: 'origin', qualifiers: [host] }
      }
      // Legacy/opaque: `browser:chromium` (v1 spelling). Kept permissive so v1
      // callers keep working; it compares by equality and claims no containment.
      return passthroughParts(rough)
    },
    subjectsConflict: (a, b) => {
      // Containment (browser:instance vs anything else browser) comes from the
      // IMPLICATIONS table, not from a branch here.
      if (tableRule('containment', a, b)) return true
      return sameSubject(a, b)
    },
  }),

  screen: defineClass('screen', {
    summary: 'The input side of the desktop: screen:focus, screen:pointer. Equality only.',
    parts: (rough) => {
      if (rough.subject === 'focus' || rough.subject === 'pointer') return fixedSubjectParts(rough)
      return passthroughParts(rough)
    },
    subjectsConflict: sameSubject,
  }),

  window: defineClass('window', {
    summary: 'A concrete window: window:hwnd:<decimal> (a bare decimal is accepted and canonicalised).',
    parts: (rough) => {
      if (rough.subject === 'hwnd') {
        if (rough.qualifiers.length !== 1) {
          throw new Error('resource lease: window:hwnd needs exactly one handle; write window:hwnd:197772')
        }
        return { subject: 'hwnd', qualifiers: [requireDecimal(rough.qualifiers[0], 'a window handle')] }
      }
      if (rough.qualifiers.length === 0 && /^\d+$/.test(rough.subject)) {
        return { subject: 'hwnd', qualifiers: [basicallyDecimal(rough.subject)] }
      }
      return passthroughParts(rough)
    },
    subjectsConflict: sameSubject,
  }),

  api: defineClass('api', {
    summary: 'A rate-limited namespace: api:<provider>:<metric>. Capacity is pool slots, never the key.',
    parts: (rough) => {
      if (rough.qualifiers.length !== 1) {
        throw new Error(
          `resource lease: api keys are api:<provider>:<metric> with metric one of ${API_METRICS.join(', ')}`,
        )
      }
      const metric = rough.qualifiers[0]
      if (!API_METRICS.includes(metric)) {
        throw new Error(
          `resource lease: unknown api metric "${metric}"; use one of ${API_METRICS.join(', ')}`,
        )
      }
      return { subject: rough.subject, qualifiers: [metric] }
    },
    subjectsConflict: sameSubject,
  }),

  named: defineClass('named', {
    summary: 'The fallback bucket: anything that is not a modelled resource. Equality only.',
    parts: passthroughParts,
    subjectsConflict: sameSubject,
  }),
})

/**
 * Behaviour for a class that is not in CLASS_NAMES: exact equality on the
 * canonical string and nothing else.
 *
 * The alternative (rejecting the key) would break v1 callers and every lock file
 * already on disk; the other alternative (guessing, e.g. treating `dir:` as
 * `path:`) would invent conflicts the contract never sanctioned.
 */
const OPAQUE_CLASS = Object.freeze({
  name: '(opaque)',
  parts: passthroughParts,
  canonical: (parsed) => joinKey(parsed.class, parsed.subject, parsed.qualifiers),
  subjectsConflict: (a, b) => sameSubject(asFacet(a), asFacet(b)),
  expandFacets: () => [],
})

/* ======================================================================== */
/* keys, canonical form, facet expansion                                    */
/* ======================================================================== */

/**
 * Split a key body into rough subject + qualifiers, rejecting empty segments.
 *
 * @param {string} cls lowercased class.
 * @param {string} rest everything after `class:`.
 * @returns {{ class: string, subject: string, qualifiers: string[] }} rough parse.
 */
function splitRough(cls, rest) {
  const segments = rest.split(':')
  if (segments.some((segment) => segment === '')) {
    throw new Error(`resource lease: "${cls}:${rest}" has an empty segment; qualifiers must not be empty`)
  }
  return {
    class: cls,
    subject: segments[0].toLowerCase(),
    qualifiers: segments.slice(1).map((segment) => segment.toLowerCase()),
  }
}

/**
 * Parse a key into its canonical parts (§2).
 *
 * Two deliberate deviations from a naive `split(':')`, both forced by the
 * contract's own examples:
 *
 *   - `path` takes EVERYTHING after `path:` as its subject, because a Windows
 *     path contains colons (`path:C:/out`) and §2 forbids colons in *subjects*.
 *   - unknown classes are accepted as opaque instead of thrown on (see
 *     OPAQUE_CLASS).
 *
 * @param {string} raw resource key, e.g. "browser:profile:work".
 * @param {{ base?: string, profileDirs?: object | Function }} [options] parse options.
 * @returns {Readonly<{ raw: string, class: string, subject: string,
 *   qualifiers: readonly string[], known: boolean, canonical: string }>} parsed key.
 */
export function parseKey(raw, options = {}) {
  if (typeof raw !== 'string') {
    throw new TypeError(`resource lease: a resource key must be a string (got ${typeof raw})`)
  }
  const opts = optionsFrom(options)
  const text = raw.trim()
  if (text === '') {
    throw new Error('resource lease: a resource key must not be empty; for example port:9222')
  }
  const colon = text.indexOf(':')
  if (colon <= 0) {
    throw new Error(
      `resource lease: "${raw}" is not a resource key; write class:subject, e.g. port:9222 (classes: ${CLASS_NAMES.join(', ')})`,
    )
  }
  const cls = text.slice(0, colon).toLowerCase()
  const rest = text.slice(colon + 1)
  if (rest === '') {
    throw new Error(`resource lease: "${raw}" has an empty subject; write ${cls}:<subject>`)
  }
  const rough =
    cls === 'path'
      ? { class: cls, subject: rest.toLowerCase(), qualifiers: [] }
      : splitRough(cls, rest)
  const known = Object.prototype.hasOwnProperty.call(CLASSES, cls)
  // An unknown class is a legitimate arbitrary resource name (race:key,
  // build:key), so it is accepted -- but if it is one edit away from a real
  // class it is far more likely a typo, and a typo here means the key silently
  // stops excluding the resource it was meant to protect (§2.1).
  if (!known) warnNearMiss(cls)
  const entry = known ? CLASSES[cls] : OPAQUE_CLASS
  const { subject, qualifiers } = entry.parts(rough, opts)
  return Object.freeze({
    raw,
    class: cls,
    subject,
    qualifiers: Object.freeze(qualifiers),
    known,
    canonical: entry.canonical({ class: cls, subject, qualifiers }, opts),
  })
}

// -------------------------------------------------------------- near miss

/** Classes already warned about, so one typo does not spam every prompt. */
const nearMissWarned = new Set()

/**
 * Whether two short strings differ by at most one insertion, deletion,
 * substitution, or ADJACENT TRANSPOSITION.
 *
 * A full Levenshtein matrix is overkill here: class names are short and the
 * only question is "one edit or fewer". Transposition has to be counted as one
 * edit (Damerau), because swapping two adjacent letters is the single most
 * common typo and plain Levenshtein scores it as two: `paht` would then pass
 * silently, which is exactly the failure this warning exists to prevent.
 *
 * @param {string} a one string.
 * @param {string} b the other.
 * @returns {boolean} true when at most one edit separates them.
 */
function withinOneEdit(a, b) {
  if (a === b) return false
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  if (la === lb) {
    const diff = []
    for (let i = 0; i < la; i += 1) {
      if (a[i] !== b[i]) diff.push(i)
      if (diff.length > 2) return false
    }
    if (diff.length === 1) return true
    if (diff.length === 2) {
      // One adjacent transposition, e.g. paht <-> path.
      return diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]
    }
    return false
  }
  const [short, long] = la < lb ? [a, b] : [b, a]
  let i = 0
  let j = 0
  let skipped = false
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1
      j += 1
      continue
    }
    if (skipped) return false
    skipped = true
    j += 1
  }
  return true
}

/**
 * Warn once when an unknown class looks like a misspelling of a known one.
 *
 * Silence here would be the worst outcome: `paht:d:/out` would become an
 * opaque singleton that never conflicts with `path:d:/out`, so the caller
 * believes the directory is protected when it is not (§2.1).
 *
 * @param {string} cls the unknown class name, already lowercased.
 * @returns {void}
 */
function warnNearMiss(cls) {
  if (nearMissWarned.has(cls)) return
  // Report EVERY near miss, not just the first: `prot` is one edit from both
  // `port` and `proc`, and picking one arbitrarily would tell the caller to
  // fix the wrong thing.
  const hits = CLASS_NAMES.filter((name) => withinOneEdit(cls, name))
  if (hits.length === 0) return
  nearMissWarned.add(cls)
  const candidates = hits.map((name) => `"${name}:"`).join(' or ')
  const message = `resource lease: unknown resource class "${cls}" looks like a typo of ${candidates}. `
    + 'It is treated as an opaque singleton, so it will NOT conflict with those keys. '
    + 'Mutual exclusion for this key is weaker than RESOURCE-MODEL-v2.md §2.1 requires.'
  try {
    process.emitWarning(message, 'ResourceLeaseWarning')
  } catch {
    /* a warning must never break key parsing */
  }
}

/**
 * The canonical form of a key -- the ONLY thing that may be compared for
 * equality or used to derive a lock filename (§2).
 *
 * @param {string} key resource key in any spelling.
 * @param {{ base?: string, profileDirs?: object | Function }} [options] parse options.
 * @returns {string} canonical key.
 */
export function canonicalKey(key, options = {}) {
  return parseKey(key, options).canonical
}

/**
 * Build the resource key for a filesystem path.
 *
 * Callers hold PATHS, not keys -- the tool guard of §9 is handed raw tool
 * arguments -- and a bare `C:/out` is not a key at all (it parses as class `c`,
 * subject `/out`). This is the one conversion every caller needs, so it lives
 * here instead of being re-derived (and mis-derived) at each call site.
 *
 * §2: "调用方要传相对路径,自己先 path.resolve() 或用 pathKey() 转成绝对路径".
 * This is that entry point, so a RELATIVE path is resolved here, explicitly,
 * against `options.base` or the caller's cwd. The resolution lives at a call
 * the caller made deliberately -- never inside canonicalPath(), where it would
 * silently make a `path:` KEY depend on the process's directory.
 *
 * @param {unknown} input path in any spelling, absolute or relative.
 * @param {{ base?: string }} [options] base for a relative path (default cwd).
 * @returns {string} canonical `path:` key.
 */
export function pathKey(input, options = {}) {
  const opts = optionsFrom(options)
  const text = String(input ?? '').trim()
  if (text === '') throw new Error('resource lease: a path must not be empty')
  const normalised = text.replace(/\\/g, '/').toLowerCase()
  const rooted = normalised.startsWith('/') || /^[a-z]:\//.test(normalised)
  if (rooted) return `path:${canonicalPath(text, opts)}`
  const hasBase = typeof opts.base === 'string' && opts.base.trim() !== ''
  const base = hasBase ? opts.base : process.cwd()
  return `path:${canonicalPath(text, { ...opts, base })}`
}

/**
 * Expand a key into the set of facets it occupies (§3.1 and §3.3.1). The first
 * element is always the key's own canonical form; the rest come from IMPLICATIONS.
 *
 * `expandFacets("browser:profile:work", { "browser:profile:work": "C:/.../User Data" })`
 *   -> ["browser:profile:work", "path:c:/.../user data"]
 *
 * The second argument is the §3.3.1 alias table, or an options object
 * (`{ aliases, profileDirs, base }`). With no mapping the key expands to itself
 * only -- and that gap is REPORTED by unresolvedAliases(), never silent.
 *
 * @param {string} key resource key in any spelling.
 * @param {Record<string, string> | { aliases?: Record<string, string>, profileDirs?: object | Function, base?: string }} [aliasesOrOptions]
 *   alias table, or an options object.
 * @returns {string[]} canonical facets, deduplicated, own facet first.
 */
export function expandFacets(key, aliasesOrOptions) {
  return expandReport(key, aliasesOrOptions).facets
}

/**
 * Expand a key and report what could not be resolved (§3.3.1).
 *
 * This is the function a caller should use where a missing alias is a real hole in
 * its protection -- the tool guard of §9, the CLI's status output -- so it can
 * warn instead of assuming the directory is covered.
 *
 * @param {string} key resource key in any spelling.
 * @param {Record<string, string> | { aliases?: Record<string, string>, profileDirs?: object | Function, base?: string }} [aliasesOrOptions]
 *   alias table, or an options object.
 * @returns {{ facets: string[], unresolved: Array<{ id: string, key: string, hint: string }> }}
 *   the facets, plus every `unresolved: 'required'` implication that produced none.
 */
export function expandReport(key, aliasesOrOptions) {
  const options = optionsFrom(aliasesOrOptions)
  const parsed = parseKey(key, options)
  const entry = parsed.known ? CLASSES[parsed.class] : OPAQUE_CLASS
  const report = derivedFacetsReport(parsed, options)
  const facets = [parsed.canonical]
  for (const facet of report.facets) {
    if (!facets.includes(facet)) facets.push(facet)
  }
  return { facets, unresolved: report.unresolved }
}

/**
 * The aliases this key NEEDS but does not have (§3.3.1).
 *
 * An empty array means "fully resolved: every facet this key can yield is known".
 * A non-empty array means the key under-protects right now: for example
 * `browser:profile:work` with no directory alias cannot collide with the
 * `path:` another agent holds, and the caller is expected to warn about it.
 *
 * @param {string} key resource key in any spelling.
 * @param {Record<string, string> | { aliases?: Record<string, string>, profileDirs?: object | Function, base?: string }} [aliasesOrOptions]
 *   alias table, or an options object.
 * @returns {Array<{ id: string, key: string, hint: string }>} unresolved implications.
 */
export function unresolvedAliases(key, aliasesOrOptions) {
  return expandReport(key, aliasesOrOptions).unresolved
}

/* ======================================================================== */
/* the conflict predicate (§3.2)                                            */
/* ======================================================================== */

/**
 * Normalise a mode argument; unknown modes are a hard error, because guessing
 * between 'shared' and 'exclusive' silently picks a safety property.
 *
 * @param {unknown} mode mode spelling; absent means 'exclusive'.
 * @returns {'exclusive' | 'shared' | 'pool'} canonical mode.
 */
export function normalizeMode(mode) {
  if (mode === undefined || mode === null || mode === '') return 'exclusive'
  const text = String(mode).toLowerCase()
  if (!MODES.includes(text)) {
    throw new Error(`resource lease: mode must be one of ${MODES.join(', ')} (got "${mode}")`)
  }
  return /** @type {'exclusive' | 'shared' | 'pool'} */ (text)
}

/**
 * Whether two modes may coexist on one facet. §3.2 exempts exactly shared+shared.
 *
 * Note for pool callers: capacity is NOT modelled here. Two `pool` holders of one
 * facet DO conflict per the literal §3.2 formula, which is why slot allocation
 * must be decided by slot files in lock.js and never by this predicate alone.
 *
 * @param {string} modeA canonical mode.
 * @param {string} modeB canonical mode.
 * @returns {boolean} true when both modes are share-compatible.
 */
function modesCompatible(modeA, modeB) {
  return COMPATIBLE_MODES.includes(modeA) && COMPATIBLE_MODES.includes(modeB)
}

/**
 * The conflict predicate of §3.2, over two EXPANDED facets:
 *
 *   conflict(fa, fb, ma, mb) :=
 *        sameClass(fa, fb) && subjectsConflict(fa, fb)
 *     && !(ma === shared && mb === shared)
 *
 * Callers must pass facets from expandFacets() (or use keysConflict() for raw
 * keys); a raw `browser:cdp:9222` compared against `port:9222` is NOT a conflict
 * at this level by design, because the cross-class relation is expressed once, as
 * a shared facet, in IMPLICATIONS.
 *
 * An unparseable facet throws rather than returning false: a silent false is a
 * missed exclusion, which is the one failure this whole module exists to prevent.
 *
 * @param {string | object} facetA facet held by A.
 * @param {string} [modeA] A's mode.
 * @param {string | object} facetB facet B wants.
 * @param {string} [modeB] B's mode.
 * @param {{ base?: string }} [options] parse options.
 * @returns {boolean} true when holding both is a violation.
 */
export function facetsConflict(facetA, modeA, facetB, modeB, options = {}) {
  const opts = optionsFrom(options)
  const a = asFacet(facetA, opts)
  const b = asFacet(facetB, opts)
  if (modesCompatible(normalizeMode(modeA), normalizeMode(modeB))) return false
  // Explicit non-relations (§3.3) veto, even if a future facet rule would have
  // made the classes meet. screen:focus vs window:* is this row.
  if (tableRule('no-conflict', a, b)) return false
  if (a.class !== b.class) return false
  const entry = a.known ? CLASSES[a.class] : OPAQUE_CLASS
  return entry.subjectsConflict(a, b, opts)
}

/**
 * Every conflicting (facetA, facetB) pair BETWEEN two lists of facets -- the raw
 * material for §4.3 "who blocked me".
 *
 * SEMANTICS, stated because it is not obvious: the two lists are compared
 * CROSS-wise (every facet of A against every facet of B). Conflicts *inside* one
 * list are not reported: a list is one request's own facet set, and §4.1 step 1
 * has already merged its duplicates (mode max, the stronger mode winning). So
 * `findConflicts(X, X)` -- the same list twice -- DOES report the inner pairs, by
 * virtue of it being two arguments, but `findConflicts(X, [])` reports nothing.
 * Neither call is deduplicated: one physical conflict can show up as several
 * facet pairs, and the caller decides how to summarise it.
 *
 * @param {ReadonlyArray<{ facet: string, mode?: string }>} listA held facets.
 * @param {ReadonlyArray<{ facet: string, mode?: string }>} listB wanted facets.
 * @param {Record<string, string> | { aliases?: object, profileDirs?: object | Function, base?: string }} [aliasesOrOptions]
 *   alias table, or an options object.
 * @returns {Array<{ facet: string, otherFacet: string }>} conflicting pairs.
 */
export function findConflicts(listA, listB, aliasesOrOptions) {
  const options = optionsFrom(aliasesOrOptions)
  const out = []
  for (const a of listA) {
    for (const b of listB) {
      if (facetsConflict(a.facet, a.mode, b.facet, b.mode, options)) {
        out.push({ facet: a.facet, otherFacet: b.facet })
      }
    }
  }
  return out
}

/**
 * Whole-key conflict test: expand both sides, then compare every facet pair. This
 * is the function callers who think in keys (the tool guard of §9, the CLI's
 * status) should use.
 *
 * @param {string} keyA resource key held by A.
 * @param {string} [modeA] A's mode.
 * @param {string} keyB resource key wanted by B.
 * @param {string} [modeB] B's mode.
 * @param {{ base?: string, profileDirs?: object | Function }} [options] parse options.
 * @returns {boolean} true when holding both is a violation.
 */
export function keysConflict(keyA, modeA, keyB, modeB, aliasesOrOptions) {
  const options = optionsFrom(aliasesOrOptions)
  const facetsA = expandFacets(keyA, options)
  const facetsB = expandFacets(keyB, options)
  for (const a of facetsA) {
    for (const b of facetsB) {
      if (facetsConflict(a, modeA, b, modeB, options)) return true
    }
  }
  return false
}

/* ======================================================================== */
/* the global total order (§3.4)                                            */
/* ======================================================================== */

/**
 * The global order key of a facet (§3.4): `canonicalClass:canonicalSubject`,
 * extended with the qualifiers.
 *
 * Why the qualifiers are appended (a deviation from the literal §3.4 formula, and
 * the one thing in this file worth arguing about): without them, every
 * `browser:profile:*` facet has the SAME order key ("browser:profile"), so the
 * order is not total and two processes requesting [profile:a, profile:b] and
 * [profile:b, profile:a] can still wait on each other -- exactly the cross-machine
 * deadlock G2 exists to prevent. With the qualifiers appended, orderKey(facet) is
 * the canonical key, and the order is total over distinct facets.
 *
 * The value must never depend on who asks, on the process, or on the machine:
 * that is why it is built from the canonical form only.
 *
 * @param {string} facet facet in any spelling.
 * @param {{ base?: string }} [options] parse options.
 * @returns {string} order key; compare with compareFacets().
 */
export function orderKey(facet, options = {}) {
  const opts = optionsFrom(options)
  const parsed = asFacet(facet, opts)
  const entry = parsed.known ? CLASSES[parsed.class] : OPAQUE_CLASS
  return entry.canonical(parsed, opts)
}

/**
 * Compare two facets in the global order (§3.4).
 *
 * §3.4 is explicit that this must be UTF-16 CODE UNIT order ("码元序"), not
 * Unicode CODE POINT order: PowerShell's `[StringComparer]::Ordinal` and Node's
 * `<` are both code-unit order, and the two disagree only for astral characters
 * (an emoji in a profile name), where code-unit order puts U+1F600 BELOW U+E000.
 * Using code points here would make the plugin and the CLI sort the same two
 * facets differently -- two machines acquiring in opposite orders, i.e. the
 * cross-machine deadlock G2 exists to prevent. So this comparator is literally
 * JS string comparison (`<`), which IS code-unit order, and a test pins that it
 * agrees with `<` on an astral character.
 *
 * A prefix sorts first, which code-unit order gives for free. Do NOT add a
 * "length first" rule: that would be a second order over the same data.
 *
 * @param {string} a first facet.
 * @param {string} b second facet.
 * @param {{ base?: string }} [options] parse options.
 * @returns {number} negative, zero or positive.
 */
export function compareFacets(a, b, options = {}) {
  const left = orderKey(a, options)
  const right = orderKey(b, options)
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Sort facets into the acquisition order of §4.1 step 2.
 *
 * @param {readonly string[]} facets facets in any spelling.
 * @param {{ base?: string }} [options] parse options.
 * @returns {string[]} canonical facets, ascending.
 */
export function sortFacets(facets, options = {}) {
  return facets.map((facet) => orderKey(facet, options)).sort((a, b) => compareFacets(a, b, options))
}

/* ======================================================================== */
/* lock filenames (§2 last paragraph)                                       */
/* ======================================================================== */

/**
 * Turn a CANONICAL key into a filename-safe base: every character outside
 * [A-Za-z0-9._-] becomes '_', then the whole string is lowercased.
 *
 * This is deliberately BYTE-IDENTICAL to `lock.js`'s sanitizeKey and to the CLI's
 * Get-KeyBase, and it is NOT part of canonical equality -- §2 is explicit that
 * semantic equality always uses the canonical key. The lowercasing is part of the
 * filename rule, not a nicety: without it a mixed-case key names a different file
 * on Linux/macOS, two agents hold "different" locks and the exclusion silently
 * fails.
 *
 * §2 also mentions length capping plus a short hash here. That is NOT implemented,
 * on purpose: changing the filename rule would stop this plugin from seeing the
 * CLI's and v1's existing lock files. It needs a coordinated CLI + plugin change,
 * so it is left to the Lead rather than smuggled into one module.
 *
 * @param {unknown} key canonical resource key.
 * @returns {string} filesystem-safe, lowercase key base.
 */
export function sanitizeKey(key) {
  return String(key).replace(/[^A-Za-z0-9._-]/g, '_').toLowerCase()
}

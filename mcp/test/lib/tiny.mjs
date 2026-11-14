/**
 * A 40-line test runner instead of a framework.
 *
 * The deliverable is a zero-dependency single file; a test suite that pulls
 * in a runner from npm would contradict the point. Output is deliberately
 * one line per assertion so a failing run can be pasted into a bug report.
 */

let passed = 0
let failed = 0
let skipped = 0
const failures = []

/**
 * Print a section header.
 *
 * @param {string} title section title.
 */
export function section(title) {
  console.log(`\n${title}`)
}

/**
 * Run one named check.
 *
 * @param {string} name what is being checked.
 * @param {() => Promise<void> | void} fn body; throw to fail.
 * @returns {Promise<void>} resolves when the check is done (never rejects).
 */
export async function test(name, fn) {
  const started = Date.now()
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${name}  (${Date.now() - started}ms)`)
  } catch (err) {
    failed += 1
    const message = err instanceof Error ? (err.message ?? String(err)) : String(err)
    failures.push({ name, message })
    console.log(`  FAIL  ${name}  (${Date.now() - started}ms)`)
    for (const line of message.split('\n')) console.log(`        ${line}`)
    if (err instanceof Error && err.stack && process.env.RL_STACK === '1') {
      console.log(err.stack)
    }
  }
}

/**
 * Record a check that could not run here, with the reason. A skip is NOT a pass:
 * it prints its own line so a green run cannot hide a missing dependency.
 *
 * @param {string} name what would have been checked.
 * @param {string} reason why it cannot run in this environment.
 */
export function skip(name, reason) {
  skipped += 1
  console.log(`  SKIP  ${name}`)
  console.log(`        ${reason}`)
}

/**
 * Print the summary and set the exit code.
 *
 * @returns {number} number of failures.
 */
export function done() {
  console.log('')
  const skippedText = skipped > 0 ? `, ${skipped} skipped` : ''
  if (failed === 0) {
    console.log(`  ${passed} passed, 0 failed${skippedText}`)
  } else {
    console.log(`  ${passed} passed, ${failed} failed${skippedText}`)
    for (const failure of failures) console.log(`   - ${failure.name}`)
    process.exitCode = 1
  }
  return failed
}

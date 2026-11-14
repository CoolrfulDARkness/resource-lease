#!/usr/bin/env node
/**
 * Run every test file in order, as separate processes, and summarise.
 *
 * Separate processes matter: the mutex and cross-tool tests are about
 * behaviour *between* processes, and a shared test process would let a bug in
 * one file's in-memory state mask a real-world failure.
 *
 * Usage:
 *   node test/run-all.mjs            run everything
 *   node test/run-all.mjs protocol   run only test files whose name matches
 *   RL_KEEP=1 node test/run-all.mjs  keep the temp lock roots for inspection
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const filter = process.argv[2]

/** @returns {string[]} test files to run, sorted. */
function testFiles() {
  return fs
    .readdirSync(HERE)
    .filter((name) => name.endsWith('.test.mjs'))
    .filter((name) => (filter === undefined ? true : name.includes(filter)))
    .sort()
}

/**
 * Run one test file, inheriting stdio so its output appears in order.
 *
 * @param {string} file absolute path of the test file.
 * @returns {Promise<number>} exit code.
 */
function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit', cwd: path.dirname(HERE), windowsHide: true })
    child.on('error', () => resolve(1))
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

const files = testFiles()
if (files.length === 0) {
  console.error(`no test files found${filter === undefined ? '' : ` matching "${filter}"`} in ${HERE}`)
  process.exit(2)
}

console.log(`resource-lease-mcp test suite: ${files.length} file(s)`)
const started = Date.now()
const results = []

for (const name of files) {
  const code = await runFile(path.join(HERE, name))
  results.push({ name, code })
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1)
const failed = results.filter((result) => result.code !== 0)

console.log(`\n${'='.repeat(56)}`)
for (const result of results) {
  console.log(`  ${result.code === 0 ? 'OK  ' : 'FAIL'}  ${result.name}`)
}
console.log(`${'='.repeat(56)}`)
if (failed.length === 0) {
  console.log(`all ${results.length} file(s) passed in ${elapsed}s`)
} else {
  console.log(`${failed.length} of ${results.length} file(s) FAILED in ${elapsed}s`)
  process.exitCode = 1
}

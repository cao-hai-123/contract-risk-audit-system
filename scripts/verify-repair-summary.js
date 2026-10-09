import assert from 'node:assert/strict'
import fs from 'node:fs'

// Validate recorded outcomes without rerunning services or modifying business data.
const report = fs.readFileSync('docs/priority-repair-results-2026-09-15.md', 'utf8')
const ids = [...report.matchAll(/^\| (D\d{2})[ |]/gm)].map((match) => match[1])
assert.deepEqual([...ids].sort(), Array.from({ length: 24 }, (_, index) => 'D' + String(index + 1).padStart(2, '0')))
const sections = report.split(/^## /m)
for (const [title, count] of [['2. 已完全修复', 7], ['3. 已部分修复', 11], ['4. 未修复', 6]]) {
  const section = sections.find((value) => value.startsWith(title))
  assert.ok(section, title)
  assert.equal([...section.matchAll(/^\| D\d{2}[ |]/gm)].length, count, title)
}
const readReceipt = (name) => JSON.parse(fs.readFileSync('tmp/priority-repairs/' + name, 'utf8'))
for (const name of ['mysql-results.json', 'http-browser-results.json']) {
  const receipt = readReceipt(name)
  assert.ok(Array.isArray(receipt.results), name + ': detailed results required')
  assert.equal(receipt.results.length, 11, name)
  assert.ok(receipt.results.every((result) => result.passed === true), name + ': every group must pass')
  assert.equal(new Set(receipt.results.map((result) => result.name)).size, 11, name + ': duplicate groups')
}
const mysql = readReceipt('mysql-results.json')
assert.equal(mysql.tablesRestored, 14)
assert.equal(mysql.sqlModes, 2)
const http = readReceipt('http-browser-results.json')
assert.equal(http.passed, 11)
assert.equal(http.cloudCalls, 0)
const local = readReceipt('local-model-results.json')
assert.equal(local.passed, 3)
assert.equal(local.cloudCalls, 0)
assert.equal(local.risk.status, 'success')
assert.ok(local.risk.acceptedDecisions >= 1)
assert.equal(local.standard.status, 'success')
assert.equal(local.risk.coverage.complete, true)
assert.equal(local.standard.coverage.complete, true)
const artifact = readReceipt('artifact-results.json')
assert.equal(artifact.passed, true)
assert.equal(artifact.keyFieldsPerFormat, 5)
assert.equal(artifact.pdfPages, 3)
assert.match(artifact.wordNativeVisualVerification, /^unverified:/)
assert.ok(report.includes('32 项通过'))
assert.ok(report.includes('Word 分页视觉验收未通过'))
assert.ok(report.includes('没有发起真实云端审核'))
console.log('PASS repair summary: D01-D24 classified once; 7 complete / 11 partial / 6 unresolved; all recorded detailed results verified; Word/cloud limits retained.')

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { classifyFamieFailure, projectRoot } from '../scripts/famie-launch-support.js'

test('registry token failures explain the Docker Desktop proxy layer', () => {
  const result = classifyFamieFailure('failed to fetch anonymous token: Get https://auth.docker.io/token: dial tcp: connectex timeout')
  assert.equal(result.code, 'registry_network')
  assert.ok(result.message.includes('Docker Desktop'))
  assert.ok(result.message.includes('docker pull python:3.8-slim'))
})
test('dependency, TLS and later network failures remain distinguishable', () => {
  assert.equal(classifyFamieFailure('ERROR: ResolutionImpossible').code, 'python_dependencies')
  assert.equal(classifyFamieFailure('certificate verify failed').code, 'tls_certificate')
  assert.equal(classifyFamieFailure('download.pytorch.org connection reset').code, 'download_network')
  assert.equal(classifyFamieFailure('unknown build error').code, 'build_failed')
})
test('direct invocation from backend keeps Compose rooted in the project', () => {
  const before = process.cwd()
  try { process.chdir(path.join(projectRoot, 'backend')); assert.equal(path.resolve(projectRoot, 'docker-compose.yml'), path.resolve(before, 'docker-compose.yml')) }
  finally { process.chdir(before) }
})

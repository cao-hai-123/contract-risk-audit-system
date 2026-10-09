import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const projectRoot = fileURLToPath(new URL('../', import.meta.url))
export function classifyFamieFailure(text = '') {
  if (/failed to fetch (?:anonymous|oauth) token|auth\.docker\.io|load metadata.*docker\.io|registry-1\.docker\.io/i.test(text)) {
    return { code: 'registry_network', message: 'Docker Hub 认证或镜像下载失败。检查 Docker Desktop → Settings → Resources → Proxies，使用可用的系统代理或手动 HTTP/HTTPS 代理，然后运行 docker pull python:3.8-slim。仅设置容器 DNS 或修改 daemon.json 代理不能修复 Docker Desktop 的下载代理。' }
  }
  if (/Could not find a version|No matching distribution|ResolutionImpossible|subprocess-exited-with-error/i.test(text)) {
    return { code: 'python_dependencies', message: 'Python 依赖解析或安装失败。查看上方首个 pip 错误及 third_party/famie/constraints.txt；不要通过关闭证书校验解决依赖冲突。' }
  }
  if (/certificate verify failed|x509|CERTIFICATE_VERIFY_FAILED/i.test(text)) {
    return { code: 'tls_certificate', message: '下载证书校验失败。检查系统时间、代理证书和受信任证书链；不要关闭 TLS 校验。' }
  }
  if (/timed?\s*out|timeout|connection.*(?:reset|refused)|network is unreachable|Temporary failure in name resolution/i.test(text)) {
    return { code: 'download_network', message: '下载或网络连接失败。基础镜像成功不代表 PyPI、download.pytorch.org 或模型下载站点均可访问，请检查失败日志中的主机及构建/容器代理。' }
  }
  return { code: 'build_failed', message: 'FAMIE 构建或启动失败。请保留上方首个错误；详细排查见 docs/famie-docker-network-repair-2026-09-16.md。' }
}

export function runDocker(args, { timeoutMs = 0, stream = false } = {}) {
  return new Promise((resolve) => {
    let output = '', settled = false, timer
    const child = spawn('docker', args, { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ...result, output }) } }
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', (data) => {
      const text = data.toString(); output = (output + text).slice(-24000)
      if (stream) process.stdout.write(text)
    })
    child.once('error', (error) => finish({ code: 1, errorCode: error.code }))
    child.once('close', (code) => finish({ code: code ?? 1 }))
    if (timeoutMs) timer = setTimeout(() => { child.kill(); finish({ code: 1, errorCode: 'timeout' }) }, timeoutMs)
  })
}

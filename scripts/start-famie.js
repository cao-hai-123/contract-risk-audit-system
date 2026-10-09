import { runDocker, classifyFamieFailure } from './famie-launch-support.js'
const engine = await runDocker(['info', '--format', '{{.OSType}}'], { timeoutMs: 15000 })
if (engine.code !== 0 || engine.output.trim() !== 'linux') {
  console.error(engine.errorCode === 'ENOENT' ? '找不到 Docker CLI。请安装 Docker Desktop 并重新打开终端。' : 'FAMIE 尚未启动：Docker Linux 引擎不可用。请启动 Docker Desktop；若 WSL2 报虚拟化不可用，请核对 Windows 功能及固件设置。')
  process.exit(1)
}
const config = await runDocker(['compose', '--profile', 'famie', 'config', '--quiet'], { timeoutMs: 15000 })
if (config.code !== 0) { console.error('FAMIE Compose 配置无效，请在项目根目录运行 docker compose --profile famie config --quiet。'); process.exit(1) }
const build = await runDocker(['compose', '--progress', 'plain', '--profile', 'famie', 'build', 'famie'], { stream: true })
if (build.code !== 0) {
  const failure = classifyFamieFailure(build.output)
  console.error(`\nFAMIE 未启动 [${failure.code}]：${failure.message}`)
  process.exit(1)
}
// Repair only the mounted directory owner for volumes created by older images.
// The long-running service remains UID 10001; no files or annotation data are removed.
const storage = await runDocker(['compose', '--profile', 'famie', 'run', '--rm', '--no-deps', '--user', '0', '--entrypoint', 'python', 'famie', '-c', 'import os; os.chown("/home/famie/.famie", 10001, 10001)'], { timeoutMs: 30000, stream: true })
if (storage.code !== 0) { console.error('FAMIE 持久目录权限初始化失败，未启动服务。请检查 Docker 命名卷状态。'); process.exit(1) }
const start = await runDocker(['compose', '--profile', 'famie', 'up', '--no-build', '-d', 'famie'], { timeoutMs: 60000, stream: true })
if (start.code !== 0) { console.error('FAMIE 容器启动失败，请检查端口 9000 占用和 docker compose logs --tail 80 famie。'); process.exit(1) }
console.log('镜像构建完成，等待 FAMIE 初始化。首次启动可能下载语言模型。')
const end = Date.now() + 300000
while (Date.now() < end) {
  try {
    const response = await fetch('http://127.0.0.1:9000/api/health', { signal: AbortSignal.timeout(3000) })
    const payload = await response.json()
    if (response.ok && payload.service === 'famie' && payload.status === 'ready') {
      console.log('FAMIE 已就绪：http://127.0.0.1:9000/。标注数据仅在用户主动上传后进入服务。'); process.exit(0)
    }
  } catch {}
  const state = await runDocker(['inspect', '--format', '{{.State.Status}} {{.RestartCount}}', 'contract-audit-famie'], { timeoutMs: 5000 })
  const [status, restarts] = state.output.trim().split(/\s+/)
  if (state.code === 0 && (['exited', 'dead', 'restarting'].includes(status) || Number(restarts) > 0)) {
    console.error('FAMIE 在初始化时退出或重启，未达到就绪状态。请运行 docker compose logs --tail 80 famie，检查依赖、目录权限和模型下载。')
    process.exit(1)
  }
  await new Promise((resolve) => setTimeout(resolve, 3000))
}
console.error('FAMIE 初始化超过五分钟，尚未就绪。请运行 docker compose logs --tail 80 famie；首次启动可能仍在下载模型。')
process.exitCode = 1

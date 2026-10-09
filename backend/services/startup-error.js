export function describeStartupError(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '')
  if (code === 'ER_BINLOG_LOGGING_IMPOSSIBLE' || /Binary logging not possible|flush stage of the commit|binlog_error_action/i.test(message)) {
    return 'MySQL 二进制日志写入或提交失败，数据库可能已保护性停止，API 未启动。请检查 MySQL 错误日志及数据目录磁盘空间/写入权限，排除故障后以管理员身份启动原 MySQL 服务（Windows：Start-Service MySQL），再运行 npm run dev。不要删除 binlog、重建数据库或关闭日志一致性保护。'
  }
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH'].includes(code)) {
    return '无法连接 MySQL，API 未启动。请确认 MySQL 服务正在运行，并核对 .env 中的 DB_HOST、DB_PORT；Windows 本机服务可在管理员 PowerShell 中执行 Start-Service MySQL。'
  }
  if (['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR'].includes(code)) {
    return 'MySQL 拒绝了连接或数据库访问，API 未启动。请核对 .env 的数据库账号、密码及授权。'
  }
  return '合同 API 启动失败（' + (/^[A-Z0-9_]+$/.test(code) ? code : 'startup_error') + '）。请检查数据库服务与配置。'
}

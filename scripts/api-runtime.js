// The API uses MySQL, never Node's process-wide browser Web Storage.
// docx's browser-compatibility code otherwise triggers Node 25's lazy getter warning.
export function apiRuntimeArguments(args = ['backend/server.js'], allowedFlags = process.allowedNodeEnvironmentFlags) {
  return [...(allowedFlags.has('--no-experimental-webstorage') ? ['--no-experimental-webstorage'] : []), ...args]
}

// Use the isolated MySQL regression suite, which covers report snapshot reuse,
// content versions, human-review persistence and all exports without user data writes.
await import('./test-priority-mysql.js')

/** 把壳层关键 module.css 导出到 .tmp-ui/shell-css/，方便 grep 与对照。 */
import { openSync, readSync, fstatSync, closeSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ASAR = 'C:\\deepseek harness\\resources\\app.asar'
const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, '.tmp-ui', 'shell-css')
mkdirSync(outDir, { recursive: true })

const head = Buffer.alloc(16)
const fd = openSync(ASAR, 'r')
readSync(fd, head, 0, 16, 0)
const headerPickleSize = head.readUInt32LE(4)
const jsonLength = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLength)
readSync(fd, jsonBuf, 0, jsonLength, 16)
closeSync(fd)
const json = JSON.parse(jsonBuf.toString('utf8'))
const dataStart = 8 + headerPickleSize
const files = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = prefix ? prefix + '/' + name : name
    if (entry.files) walk(entry, full)
    else if (entry.offset !== undefined) files.push({ path: full, offset: Number(entry.offset), size: entry.size })
  }
}
walk(json, '')
function readFile(entry) {
  const f = openSync(ASAR, 'r')
  const buf = Buffer.alloc(entry.size)
  readSync(f, buf, 0, entry.size, dataStart + entry.offset)
  closeSync(f)
  return buf.toString('utf8')
}

const wanted = [
  'dsh-client-ui-sidebar/src/client/SidebarRoot.module.css',
  'dsh-client-ui-layout/src/client/AppFrame.module.css',
  'dsh-client-ui-conversation/src/client/skeleton/InputBar.module.css',
  'dsh-client-ui-conversation/src/client/skeleton/ConversationRoot.module.css',
  'dsh-client-ui-conversation/src/client/skeleton/HeroShell.module.css',
  'dsh-client-ui-chat/src/client/chat/ChatView.module.css',
  'dsh-client-ui-chat/src/client/chat/MessageItem.module.css',
  'dsh-client-ui-chat/src/client/chat/StatsPills.module.css',
  'dsh-client-ui-chat/src/client/chat/TurnNavigator.module.css',
  'dsh-client-ui-workspace/src/client/rows/Rows.module.css',
  'dsh-client-ui-workspace/src/client/rows/WorkspaceBrowser.module.css',
]
for (const suffix of wanted) {
  const entry = files.find((f) => f.path.endsWith(suffix))
  if (!entry) { console.log('MISS', suffix); continue }
  const name = suffix.split('/').pop()
  writeFileSync(join(outDir, name), readFile(entry))
  console.log('ok', name, entry.size)
}
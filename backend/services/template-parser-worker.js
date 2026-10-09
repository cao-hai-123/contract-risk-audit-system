import fs from 'node:fs/promises'
import { parseContractDocument } from './document-parser.js'
const parsed = await parseContractDocument({ originalname: process.argv[3], buffer: await fs.readFile(process.argv[2]) })
process.send(parsed, () => process.exit(0))

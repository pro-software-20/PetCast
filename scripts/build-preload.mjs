import { readFile, writeFile } from 'node:fs/promises'
import ts from 'typescript'

// Sandboxed Electron preloads need CommonJS. Keep the authoring file typed and the sandbox on.
const source = await readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
await writeFile(new URL('../dist-electron/preload.cjs', import.meta.url), output, 'utf8')

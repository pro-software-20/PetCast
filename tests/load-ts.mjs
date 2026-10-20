import { readFile } from 'node:fs/promises'
import ts from 'typescript'
const modules = new Map()

// Compile isolated TS modules with their relative dependencies, without emitting build artifacts.
async function moduleUrl(file) {
  if (modules.has(file.href)) return modules.get(file.href)
  let code = ts.transpileModule(await readFile(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const imports = [...code.matchAll(/from\s+(['"])(\.\.?\/[^'"]+)\1/g)]
  for (const match of imports) {
    const target = new URL(match[2].replace(/\.js$/, '') + '.ts', file)
    code = code.replace(match[0], `from '${await moduleUrl(target)}'`)
  }
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  modules.set(file.href, url)
  return url
}
export async function loadTs(relative) {
  return import(await moduleUrl(new URL(relative, import.meta.url)))
}

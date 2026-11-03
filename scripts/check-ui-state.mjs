import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
const source = await readFile(new URL('../ui/studioState.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { parseEnvironment, logLines, highlight, readPreference, writePreference } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const env = parseEnvironment('# comment\r\nNAME=a=b\r\nEMPTY=\n_UNICODE=中文 空格\n__proto__=safe')
assert.deepEqual({ ...env.values }, { NAME: 'a=b', EMPTY: '', _UNICODE: '中文 空格', ['__proto__']: 'safe' })
assert.deepEqual(env.errors, {})
assert.deepEqual(Object.keys(parseEnvironment('1BAD=x\nMISSING\nPATH=a\npath=b\nA-B=c').errors), ['0', '1', '3', '4'])
assert.deepEqual(logLines([{ stream: 'stdout', text: 'hel' }, { stream: 'stderr', text: 'error\n' }, { stream: 'stdout', text: 'lo\n\nlast' }, { stream: 'stdout', text: ' line' }]), [
  { stream: 'stdout', text: 'hello' }, { stream: 'stderr', text: 'error' }, { stream: 'stdout', text: '' }, { stream: 'stdout', text: 'last line' },
])
assert.deepEqual(highlight('<img>Hello HELLO', 'hello'), [{ text: '<img>', match: false }, { text: 'Hello', match: true }, { text: ' ', match: false }, { text: 'HELLO', match: true }])
assert.deepEqual(highlight('[a].*', '.*'), [{ text: '[a]', match: false }, { text: '.*', match: true }])
assert.equal(highlight('aaaa', 'aa').filter(part => part.match).length, 2)
assert.equal(readPreference('missing'), null)
globalThis.localStorage = { getItem: () => '{bad json', setItem: () => { throw Error('blocked') } }
assert.equal(readPreference('corrupt'), null)
assert.doesNotThrow(() => writePreference('view', 'compact'))
console.log('PASS environment validation, stream reassembly, literal search highlighting and storage failure fallback')

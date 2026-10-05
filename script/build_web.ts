import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyDependencies } from './check_dependencies.ts';

const root = resolve(import.meta.dir, '..');
verifyDependencies(root);
const destination = resolve(root, 'dist/dot.web');
const shell = readFileSync(resolve(root, '../f/bend2/std/F/browser/shell.js'), 'utf8');
if (!shell.includes('options.host?.')) throw Error('The adjacent F browser host must support application IO adapters.');
// Keep LLVM optimization without Binaryen's expensive whole-evaluator -O3 pass.
// Clang 24's unreachable-warning pass also stalls on the generated switch;
// Bend checks the source and C compilation errors remain fatal.
const build = Bun.spawn(['bun', '../f/bend2/tool.ts', 'web.bend', '-o', 'dist/dot.web', '--web-corpus-mib', '128'], {
  cwd: root, stdout: 'inherit', stderr: 'inherit',
  env: { ...process.env, EMCC_CFLAGS: `${process.env.EMCC_CFLAGS ?? ''} -O1 -w` },
});
if (await build.exited !== 0) throw Error('Dot web compilation failed.');
mkdirSync(destination, { recursive: true });
const assets = ['index.html', 'dot.css', 'dot.mjs', 'host.mjs', 'media.mjs', 'transport.mjs'];
for (const file of assets) copyFileSync(resolve(root, 'web', file), resolve(destination, file));
copyFileSync(resolve(root, 'mobile/nearling-original.png'), resolve(destination, 'nearling-original.png'));
const manifestPath = resolve(destination, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.files = [...new Set([...manifest.files, ...assets, 'nearling-original.png'])];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`Dot web build: ${destination}`);

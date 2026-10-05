import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function verifyDependencies(root: string) {
  const lock = JSON.parse(readFileSync(resolve(root, 'dependencies.lock.json'), 'utf8'));
  if (lock.version !== 1) throw Error('Unsupported dependency lock version.');
  for (const [name, dependency] of Object.entries(lock.dependencies) as [string, { path: string; revision: string; version?: string }][]) {
    if (!/^[a-f0-9]{40}$/.test(dependency.revision)) throw Error(`Invalid ${name} dependency revision.`);
    const directory = resolve(root, dependency.path);
    let head: string;
    try { head = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch { throw Error(`Missing ${name} dependency. Initialize its pinned checkout before building.`); }
    if (head !== dependency.revision) throw Error(`${name} dependency changed. Use revision ${dependency.revision} or explicitly update dependencies.lock.json.`);
    const dirty = execFileSync('git', ['-C', directory, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
    if (dirty) throw Error(`${name} dependency has uncommitted changes. Commit and update its pin before building.`);
    if (dependency.version) {
      const version = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).version;
      if (version !== dependency.version) throw Error(`${name} dependency version does not match its lock.`);
    }
  }
  return lock.dependencies;
}

if (import.meta.main) {
  verifyDependencies(resolve(import.meta.dir, '..'));
  console.log('Dependency revisions and versions match the lock.');
}

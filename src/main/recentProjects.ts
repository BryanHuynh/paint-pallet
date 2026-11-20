import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectFile } from '../shared/paintProject';

const MAX_RECENT_PROJECTS = 8;
const identity = (name: string) => process.platform === 'win32' ? name.toLowerCase() : name;

export function projectFile(file: string): ProjectFile {
  const resolved = path.resolve(file);
  return { path: resolved, name: path.basename(resolved) };
}

export function isProjectPath(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value) && path.extname(value).toLowerCase() === '.paintproject';
}

export class RecentProjects {
  private pending = Promise.resolve();

  constructor(private readonly storePath: string) {}

  private async read(): Promise<string[]> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.storePath, 'utf8'));
      if (Array.isArray(value)) return value.filter(isProjectPath).slice(0, MAX_RECENT_PROJECTS);
    } catch {
      // An unavailable preferences file does not prevent opening projects.
    }
    return [];
  }

  async list() {
    await this.pending;
    return (await this.read()).map(projectFile);
  }

  remember(file: string) { return this.update(file, true); }
  forget(file: string) { return this.update(file, false); }

  private update(file: string, add: boolean) {
    const operation = this.pending.then(async () => {
      const resolved = path.resolve(file);
      const next = (await this.read()).filter((item) => identity(item) !== identity(resolved));
      if (add) next.unshift(resolved);
      const temporary = this.storePath + '.' + randomUUID() + '.tmp';
      try {
        await fs.mkdir(path.dirname(this.storePath), { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(next.slice(0, MAX_RECENT_PROJECTS)), { flag: 'wx' });
        await fs.rename(temporary, this.storePath);
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

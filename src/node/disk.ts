// The real disk behind the VirtualDisk interface, for the command line.
// Symbolic links are followed before the file policy looks at a path.

import {
  appendFileSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { OSError, VirtualDisk } from "../dxl/files.ts";

const slashes = (path: string) => path.replaceAll("\\", "/");

export class RealDisk extends VirtualDisk {
  constructor(cwd: string, program: string) {
    super(slashes(cwd));
    this.program = this.resolve(slashes(program));
  }

  override resolve(path: string): string {
    // Component by component, so that a link whose target does not exist yet is
    // followed too: writing through it would create the file where it points.
    let done = parse(path).root;
    const rest = path.slice(done.length).split(/[\\/]/).filter(Boolean);
    for (let hops = 0; rest.length;) {
      const next = join(done, rest.shift()!);
      if (!lstatSync(next, { throwIfNoEntry: false })?.isSymbolicLink()) {
        done = next;
        continue;
      }
      if (++hops > 40) throw new OSError(62, "Too many levels of symbolic links", path);
      const target = resolve(dirname(next), readlinkSync(next));
      done = parse(target).root;
      rest.unshift(...target.slice(done.length).split(/[\\/]/).filter(Boolean));
    }
    return slashes(done);
  }

  override is_folder(full: string): boolean {
    // The temporary folder is /tmp to a script on every system.
    return full === "/tmp" || statSync(full, { throwIfNoEntry: false })?.isDirectory() === true;
  }

  override make_folder(full: string): void {
    mkdirSync(full);
  }

  override children(full: string): string[] {
    return readdirSync(full);
  }

  override has(path: string): boolean {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  }

  override get(path: string): string | undefined {
    return this.has(path) ? readFileSync(path, "utf8") : undefined;
  }

  override set(path: string, text: string): this {
    writeFileSync(path, text, "utf8");
    return this;
  }

  override append(full: string, text: string): void {
    appendFileSync(full, text, "utf8");
  }

  override move(from: string, to: string): void {
    renameSync(from, to);
  }

  override duplicate(from: string, to: string): void {
    copyFileSync(from, to);
  }

  override delete(path: string): boolean {
    if (!this.has(path)) return false;
    unlinkSync(path);
    return true;
  }
}

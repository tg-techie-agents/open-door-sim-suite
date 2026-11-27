// Which files a script may touch, and the disk they live on.
//
// DOORS lets DXL reach any file the user can. Here a script may have been written
// by somebody else, or by an AI, so by default: it reads inside the folder it was
// started in and its own folder, and it writes only data files inside the folder
// it was started in, never over this program.
//
// A browser has no real disk. Files live in a VirtualDisk (absolute "/" path ->
// text). Folders are implied by the files in them; "/", the disk's cwd and the
// temporary folder always exist. The command line puts the real disk behind the
// same interface (src/node/disk.ts).
//
// read(path) and write(path) only check and return the full path; readText,
// writeText and the rest do the work and do not check.

import { Fault, compare_text } from "./runtime.ts";
import { py_repr } from "./syntax.ts";

export class OSError extends Error {
  errno: number | null;
  strerror: string | null;
  filename: string | null;
  constructor(errno: number | null, strerror: string | null, filename: string | null = null, message?: string) {
    super(message ?? `[Errno ${errno}] ${strerror}` + (filename === null ? "" : `: ${py_repr(filename)}`));
    this.name = "OSError";
    this.errno = errno;
    this.strerror = strerror;
    this.filename = filename;
  }
  toString(): string {
    return this.message;
  }
}

const missing = (path: string) => new OSError(2, "No such file or directory", path);
const is_folder = (path: string) => new OSError(21, "Is a directory", path);

// -- POSIX paths --------------------------------------------------------------

const DRIVE = /^[A-Za-z]:(?=\/|$)/;
export const is_absolute = (path: string) => path.startsWith("/") || DRIVE.test(path);

export function normpath(path: string): string {
  const drive = DRIVE.exec(path)?.[0] ?? "";
  const rest = path.slice(drive.length);
  const absolute = drive !== "" || rest.startsWith("/");
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else if (part !== ".." || !absolute) parts.push(part);
  }
  const joined = parts.join("/");
  return absolute ? drive + "/" + joined : joined || ".";
}

export function join_path(...parts: string[]): string {
  let out = "";
  for (const part of parts) {
    if (is_absolute(part)) out = part;
    else if (out === "" || out.endsWith("/")) out += part;
    else out += "/" + part;
  }
  return out;
}

export function dirname(path: string): string {
  const head = path.slice(0, path.lastIndexOf("/") + 1);
  return /^\/*$/.test(head) ? head : head.replace(/\/+$/, "");
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function splitext(path: string): [string, string] {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot < 0 || /^\.*$/.test(name.slice(0, dot))) return [path, ""];
  const cut = path.length - name.length + dot;
  return [path.slice(0, cut), path.slice(cut)];
}

export const TEMP_FOLDER = "/tmp";

export class VirtualDisk extends Map<string, string> {
  cwd: string;
  program = "/program"; // the folder holding this program, which scripts never write into
  folders: Set<string> = new Set(); // made by mkdir, and perhaps still empty
  constructor(cwd: string = "/work") {
    super();
    this.cwd = normpath(cwd);
  }

  /** The path a name really leads to (a real disk follows symbolic links). */
  resolve(path: string): string {
    return path;
  }

  /** Adding to, moving and copying a file that exists. A real disk does these
   * without reading the text, so other encodings are not rewritten. */
  append(full: string, text: string): void {
    this.set(full, (this.get(full) ?? "") + text);
  }

  move(from: string, to: string): void {
    const text = this.get(from)!;
    this.delete(from);
    this.set(to, text);
  }

  duplicate(from: string, to: string): void {
    this.set(to, this.get(from)!);
  }

  is_folder(full: string): boolean {
    if (full === "/" || full === this.cwd || full === TEMP_FOLDER) return true;
    const prefix = full + "/";
    if (this.cwd.startsWith(prefix)) return true;
    for (const name of this.keys()) if (name.startsWith(prefix)) return true;
    for (const name of this.folders) if (name === full || name.startsWith(prefix)) return true;
    return false;
  }

  make_folder(full: string): void {
    this.folders.add(full);
  }

  /** The names directly inside a folder. */
  children(full: string): string[] {
    const prefix = join_path(full, "");
    const names = new Set<string>();
    for (const name of [...this.keys(), ...this.folders]) {
      if (name.startsWith(prefix)) names.add(name.slice(prefix.length).split("/")[0]);
    }
    return [...names];
  }
}

// -- the policy ---------------------------------------------------------------

export const PROGRAM_FOLDERS = ["src", "examples", "scripts", "test", "docs", "dist"];
export const PROGRAM_FILES = new Set(["readme.md", "package.json", "package-lock.json", "tsconfig.json",
  "agents.md", "claude.md"]);
export const DATA = new Set([".csv", ".tsv", ".txt", ".log", ".xml", ".json", ".html", ".htm", ".md",
  ".rtf", ".dat", ".reqif", ".tmp"]);

export function _inside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(join_path(folder, ""));
}

export class Files {
  disk: VirtualDisk;
  root: string;
  script_dir: string;
  writable: boolean;
  anywhere: boolean;
  include_dirs: string[]; // further folders #include looks in, and may read

  constructor(script_dir: string = ".", writable: boolean = true, anywhere: boolean = false,
    disk: VirtualDisk | null = null, include_dirs: string[] = []) {
    this.disk = disk ?? new VirtualDisk();
    this.root = this.disk.resolve(this.disk.cwd);
    this.script_dir = this.realpath(script_dir);
    this.writable = writable;
    this.anywhere = anywhere;
    this.include_dirs = include_dirs.map((dir) => this.realpath(dir));
  }

  /** `path` made absolute against the disk's cwd. */
  realpath(path: string): string {
    // DOORS is a Windows program, so scripts may write "C:\\temp\\x.csv".
    return this.disk.resolve(normpath(join_path(this.disk.cwd, path.replaceAll("\\", "/"))));
  }

  getcwd(): string {
    return this.disk.cwd;
  }

  gettempdir(): string {
    return TEMP_FOLDER;
  }

  /** A name tempFileName() hands out. */
  _temporary(path: string): boolean {
    return dirname(path) === this.disk.resolve(TEMP_FOLDER) && basename(path).startsWith("DOORS");
  }

  /** Inside `folder`, and not through anything hidden or oddly named below it. */
  _open_in(full: string, folder: string): boolean {
    if (!_inside(full, folder)) return false;
    return full.slice(folder.length).split("/").filter(Boolean)
      .every((part) => !part.startsWith(".") && !/[. ]$|:/.test(part));
  }

  read(path: string): string {
    const full = this.realpath(path);
    if (this.anywhere || this._temporary(full) || this._open_in(full, this.root)
      || this._open_in(full, this.script_dir)) {
      return full;
    }
    throw new Fault(`${py_repr(path)} is outside the folders a script may read here `
      + "(see 'Files a script may use' in the README)");
  }

  /** As read(), for #include only: the folders named for it are open to it too. */
  include(path: string): string {
    const full = this.realpath(path);
    return this.include_dirs.some((dir) => this._open_in(full, dir)) ? full : this.read(path);
  }

  write(path: string): string {
    if (!this.writable) throw new Fault("layout DXL cannot write, rename, or delete files");
    const full = this.realpath(path);
    const extension = splitext(basename(full))[1].toLowerCase(), data = DATA.has(extension);
    // tempFileName() hands out names with no extension
    if (this.anywhere || (this._temporary(full) && (data || extension === ""))) return full;
    const protected_ = PROGRAM_FOLDERS.map((name) => join_path(this.disk.program, name));
    const name = basename(full);
    const own = _inside(full.toLowerCase(), this.disk.program.toLowerCase()) && PROGRAM_FILES.has(name.toLowerCase());
    if (this._open_in(full, this.root) && data && !own
      && !protected_.some((folder) => _inside(full.toLowerCase(), folder.toLowerCase()))) {
      return full;
    }
    throw new Fault(`a script may not write ${py_repr(path)} here: only data files (.csv, .txt, ...) inside `
      + `${this.root}, outside the program's own folders`);
  }

  /** A new folder, where a script may write. Its parent must be there already. */
  mkdir(path: string): void {
    if (!this.writable) throw new Fault("layout DXL cannot write, rename, or delete files");
    const full = this.realpath(path);
    const protected_ = PROGRAM_FOLDERS.map((name) => join_path(this.disk.program, name));
    const allowed = this.anywhere || (this._open_in(full, this.root)
      && !protected_.some((folder) => _inside(full.toLowerCase(), folder.toLowerCase())));
    if (!allowed) {
      throw new Fault(`a script may not make the folder ${py_repr(path)} here: only inside ${this.root}, `
        + "outside the program's own folders");
    }
    if (this.exists(full)) throw new Fault(`mkdir: ${py_repr(path)} already exists; what DOORS does then is not documented`);
    if (!this.isdir(dirname(full))) throw new Fault(`mkdir: the folder to hold ${py_repr(path)} does not exist`);
    this.disk.make_folder(full);
  }

  // -- the disk ---------------------------------------------------------------

  isdir(path: string): boolean {
    const full = this.realpath(path);
    return full === this.script_dir || this.disk.is_folder(full);
  }

  exists(path: string): boolean {
    return this.disk.has(this.realpath(path)) || this.isdir(path);
  }

  /** The file's text, without a byte order mark. */
  readText(path: string): string {
    const full = this.realpath(path);
    const text = this.disk.get(full);
    if (text === undefined) throw this.isdir(full) ? is_folder(full) : missing(full);
    return text.startsWith("﻿") ? text.slice(1) : text;
  }

  /** The full path of a file that may be created or replaced there. */
  _target(path: string): string {
    const full = this.realpath(path);
    if (this.isdir(full)) throw is_folder(full);
    if (!this.isdir(dirname(full))) throw missing(full);
    return full;
  }

  writeText(path: string, text: string): void {
    this.disk.set(this._target(path), text);
  }

  appendText(path: string, text: string): void {
    this.disk.append(this._target(path), text);
  }

  remove(path: string): void {
    const full = this.realpath(path);
    if (!this.disk.delete(full)) throw this.isdir(full) ? is_folder(full) : missing(full);
  }

  rename(source: string, target: string): void {
    const from = this.realpath(source);
    if (!this.disk.has(from)) throw missing(from); // folders cannot be renamed here
    this.disk.move(from, this._target(target));
  }

  copy(source: string, target: string): void {
    const from = this.realpath(source), to = this.realpath(target);
    if (!this.disk.has(from)) throw this.isdir(from) ? is_folder(from) : missing(from);
    if (from === to) {
      throw new OSError(null, null, null, `${py_repr(from)} and ${py_repr(to)} are the same file`);
    }
    this.disk.duplicate(from, this._target(to));
  }

  /** The names in a folder, sorted. */
  list(path: string): string[] {
    const full = this.realpath(path);
    if (!this.isdir(full)) {
      throw this.disk.has(full) ? new OSError(20, "Not a directory", full) : missing(full);
    }
    return this.disk.children(full).sort(compare_text);
  }
}

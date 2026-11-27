// A folder of the person's own computer that scripts can use. A browser that can
// give a page a folder (Chrome, Edge) gives the one the person picks. Its text
// files are copied into the open database under <name>/, where scripts and the
// desktop treat them as any file, and what is written there is written back.
// Nothing in the real folder is ever deleted or renamed.

// app.js's globals.
declare function h(tag: string, props?: any, ...children: any[]): any;
declare function dialog(title: string, content: any, buttons?: any[]): unknown;
declare function say(message: string, error?: boolean): void;

const TAKEN = /\.(dxl|inc|csv|tsv|txt|log|xml|json|html?|md|rtf|dat|reqif)$/i;
const MAX_FILES = 200, MAX_BYTES = 5 * 1024 * 1024; // every change writes the files out with the database
const MAX_SEEN = 5000, MAX_DEPTH = 6;

type Choice = [string, () => unknown];
type Files = [string, string][];
type Mount = { dir: any; name: string; key: string; known: Map<string, string> }; // known: as on the disk

export type Database = {
  key(): string;
  // The database's copies under `name`/ become these.
  put(name: string, files: Files): Promise<unknown>;
};

export function decode_text(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (e) {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

// What a script could not name is left alone.
const usable = (name: string) => !name.startsWith(".") && !/[. ]$|[:\\/]/.test(name);

async function read(dir: any): Promise<{ files: Files; left: number }> {
  const files: Files = [];
  let left = 0, size = 0, seen = 0;
  const walk = async (folder: any, below: string, depth: number) => {
    for await (const [name, entry] of folder.entries()) {
      if (++seen > MAX_SEEN) throw new Error("That folder holds too much. Pick a smaller one.");
      if (!usable(name)) left++;
      else if (entry.kind === "directory") {
        if (depth < MAX_DEPTH) await walk(entry, below + name + "/", depth + 1);
        else left++;
      } else if (!TAKEN.test(name) || files.length >= MAX_FILES) left++;
      else {
        const file = await entry.getFile();
        if (size + file.size > MAX_BYTES) { left++; continue; }
        const bytes = await file.arrayBuffer();
        if (new Uint8Array(bytes).includes(0)) { left++; continue; }
        size += file.size;
        files.push([below + name, decode_text(bytes)]);
      }
    }
  };
  await walk(dir, "", 0);
  return { files, left };
}

async function write(dir: any, path: string, text: string): Promise<void> {
  const parts = path.split("/");
  const name = parts.pop()!;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const stream = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await stream.write(text);
  await stream.close();
}

export function folder_link(database: Database) {
  let mount: Mount | null = null;
  const prefix = (name: string) => `/work/${name}/`;

  const load = async (dir: any) => {
    const name = String(dir.name).replace(/[:\\/]/g, "_").replace(/^\.+|[. ]+$/g, "") || "folder";
    const { files, left } = await read(dir);
    mount = null; // copying in is not something to write back
    await database.put(name, files);
    mount = { dir, name, key: database.key(), known: new Map(files.map(([p, text]) => [prefix(name) + p, text])) };
    say(`${files.length} file${files.length === 1 ? "" : "s"} from the folder, under ${name}/`
      + (left ? `; ${left} not taken (not text, hidden, or over the limit)` : ""));
  };

  const pick = async () => {
    let dir: any;
    try {
      dir = await (window as any).showDirectoryPicker({ mode: "readwrite" });
    } catch (e: any) {
      if (e?.name === "AbortError") return false; // nothing was picked
      throw e;
    }
    await load(dir);
  };

  const ask = () => {
    if (!(window as any).showDirectoryPicker) {
      dialog("A folder from this computer", h("div", {}, h("p", {},
        "This browser cannot give a page a folder. Chrome and Edge can. Here, use Add files, and Save to file on "
        + "what a script writes.")));
      return;
    }
    dialog("Use a folder from this computer", h("div", {},
      h("p", {}, "The page gets the folder you pick and nothing else on the computer, and sends nothing anywhere."),
      h("ul", {},
        h("li", {}, `Its text files (scripts, CSV, and the like), up to ${MAX_FILES} files and 5 MB, are copied into `
          + "the open database, under the folder's name. Copies already under that name are replaced. They stay with "
          + "the database in this browser, and in a file saved from it, until you delete them."),
        h("li", {}, "What a script writes there is written to the real folder, as UTF-8, replacing a file of the "
          + "same name without asking again."),
        h("li", {}, "A run that does not save (Try without saving, or a module open read-only) leaves the folder "
          + "and its copies as they were, and says what it would have written there."),
        h("li", {}, "Nothing in the real folder is deleted or renamed, whatever a script does."),
        h("li", {}, "The link ends when the page is reloaded or closed. To see edits made outside, read it again.")),
      h("p", {}, "Made-up data only.")),
    [{ label: "Pick a folder...", primary: true, action: pick }, { label: "Cancel" }]);
  };

  const attempt = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (e: any) {
      say(`The folder could not be read: ${e.message}`, true);
    }
  };

  return {
    // The folder whose copies are in the open database, if one is linked.
    linked: (): string | null => (mount && database.key() === mount.key ? mount.name : null),
    choices(): Choice[] {
      if (!mount) {
        const only = (window as any).showDirectoryPicker ? "" : "\nChrome and Edge only";
        return [["Use a folder from this computer..." + only, ask]];
      }
      const { dir, name } = mount;
      return [[`Read folder ${name} again`, () => attempt(() => load(dir))],
        [`Stop using folder ${name}`, () => { mount = null; say(`${name} is no longer written to. Its copies remain.`); }]];
    },
    // After a change to the open database: `files` as they now are, `written` those
    // a script has just written.
    async changed(files: Files, written: string[]): Promise<void> {
      if (!mount || database.key() !== mount.key) return;
      const { dir, name, known } = mount;
      const now = new Set(written);
      const done: string[] = [], failed: string[] = [];
      for (const [path, text] of files) {
        if (!path.startsWith(prefix(name)) || (known.get(path) === text && !now.has(path))) continue;
        const inside = path.slice(prefix(name).length);
        try {
          await write(dir, inside, text);
          done.push(inside);
          known.set(path, text);
        } catch (e: any) {
          failed.push(`${inside} (${e.message})`); // tried again at the next change
        }
      }
      if (failed.length) say(`NOT written to the folder ${name}: ${failed.join(", ")}`, true);
      else if (done.length) say(`Written to the folder ${name}: ${done.join(", ")}`);
    },
  };
}

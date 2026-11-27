// The page's scripts arrive one at a time. app.js comes before the files that
// define names its first drawing needs, so it must not start until all have run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { read_file } from "./helpers.ts";

test("the page does not start before the later scripts have run", async () => {
  const anything: any = new Proxy(function () {}, {
    get: (_, key) => key === Symbol.toPrimitive ? () => "" : key === "then" ? undefined : anything,
    apply: () => anything,
    construct: () => anything,
    set: () => true,
  });
  let asked = 0;
  const ready: Array<() => void> = [];
  const listen = (event: string, call: () => void) => { if (event === "DOMContentLoaded") ready.push(call); };
  const window = new Proxy({
    addEventListener: listen,
    opendoorTransport: () => { asked++; return new Promise(() => {}); },
  } as any, { get: (own, key) => key in own ? own[key] : anything });
  runInNewContext(read_file("src/web/app.js"), {
    window, document: new Proxy({ addEventListener: listen } as any,
      { get: (own, key) => key in own ? own[key] : anything }),
    localStorage: anything, sessionStorage: anything, navigator: anything, location: anything,
    matchMedia: anything, requestAnimationFrame: anything, setTimeout, clearTimeout,
  });
  assert.equal(asked, 0, "app.js asked for data while the page was still loading");
  assert.equal(ready.length, 1);
  ready[0]();
  await new Promise((done) => setTimeout(done, 0));
  assert.ok(asked > 0, "the page never started");
});

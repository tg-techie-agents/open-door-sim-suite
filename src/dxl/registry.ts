// How DXL features are added to the engine.
//
// Each file in `ts/dxl/lib/` defines `register(lib)` and declares what it offers
// here. The compiler type-checks scripts against these declarations, so an
// implementation never has to check argument types, and anything not declared is
// rejected by name before a script runs.
//
// Types are strings. Base values: "int" (number), "real" (number), "bool",
// "char" (string of length 1), "string". Handle types are whatever `lib.type()`
// declares; their values are any object, and null is DXL null. Array types are
// "string[]", "int[]", ...
//
// Parameter types may also be:
//     "&int"   by reference: the implementation gets a Ref with .get() / .set(v)
//     "any"    any value (the call site's type)
//     "&any"   any variable by reference; Ref.type is its DXL type
//     "attr"   an attribute reference o."Name": the implementation gets AttrRef
// A return type may be "any": the value must then be a Typed(type, value), and the
// script's context (a cast or the variable assigned) says which type it expects.
//
// Implementations are called as impl(rt, ...values), rt being a runtime.Runtime.
// Throw runtime.Fault for a DXL run-time error.
//
// A Map keyed by several strings at once is keyed by key(...parts):
// the parts joined with "\0", null as "".

import { ValueError } from "./runtime.ts";

export type Impl = (...args: any[]) => any;

export function key(...parts: Array<string | null>): string {
  return parts.map((p) => p ?? "").join("\0");
}

export class Overload {
  params: readonly string[];
  returns: string;
  impl: any;
  constructor(params: readonly string[], returns: string, impl: any) {
    this.params = params;
    this.returns = returns;
    this.impl = impl;
  }
}

export class Library {
  types: Set<string> = new Set(["int", "real", "bool", "char", "string"]);
  handles: Set<string> = new Set();
  functions: Map<string, Overload[]> = new Map(); // name -> [Overload]
  loops: Map<string, Impl> = new Map(); // key(source type, loop variable type) -> fn(rt, source) -> iterable
  arrows: Map<string, Impl> = new Map(); // key(arrow, owner type, variable type) -> fn(rt, owner, name) -> iterable
  juxtas: Map<string, [string, Impl]> = new Map(); // key(left, right) -> [result type, fn(rt, left, right)]
  operators: Map<string, [string, Impl]> = new Map(); // key(op, left, right) -> [result type, fn(rt, left, right)]
  indexes: Map<string, [string, Impl]> = new Map(); // key(base type, index type) -> [result type, fn(rt, base, index)]
  slices: Map<string, [string, Impl]> = new Map(); // base type -> [result type, fn(rt, base, start, stop or null)]
  // key(owner type, name) -> [type, getter(rt, owner), setter or null]
  properties: Map<string, [string, Impl, Impl | null]> = new Map();
  strings: Map<string, Impl> = new Map(); // type -> fn(rt, value) -> string, for types that concatenate like base types
  defaults: Map<string, Impl> = new Map(); // type -> fn(rt) -> value, for a declared but uninitialised variable
  attrs: Map<string, [Impl, Impl]> = new Map(); // owner type -> [getter(rt, owner, name), setter(rt, owner, name, str)]
  rich_attrs: Map<string, Impl> = new Map(); // owner type -> fn(rt, owner, name, markup): `x."name" = richText ...`
  currents: Map<string, Impl> = new Map(); // `current <type>` where it is not simply what was set: fn(rt) -> value
  resets: Map<string, Impl> = new Map(); // owner type -> fn(rt, owner, name), for `x."name" = (string null)`
  // key(owner type, name) -> [type, getter]: a second type the same property can be read as
  second_readings: Map<string, [string, Impl]> = new Map();
  from_attr: Map<string, Impl> = new Map(); // type -> fn(rt, str) -> value, for `Date d = o."When"`
  chains: Set<string> = new Set(); // types for which `(x += y)` is x, so appends can be chained
  temporaries: Set<string> = new Set(); // functions whose result must be used at once, never kept

  /** Declare a handle type. `to_string` lets `value " "` work; `default_`
   * builds the value of `Name x` with no initialiser (else null). */
  type(name: string, to_string: Impl | null = null, default_: Impl | null = null): void {
    this.types.add(name);
    this.handles.add(name);
    if (to_string) this.strings.set(name, to_string);
    this.defaults.set(name, default_ || (() => null));
  }

  /** Add an overload. `params` is a sequence of type strings. */
  add(name: string, params: readonly string[], returns: string, impl: Impl): void {
    let overloads = this.functions.get(name);
    if (!overloads) this.functions.set(name, overloads = []);
    const copy = [...params];
    if (overloads.some((o) => o.returns === returns && same_params(o.params, copy))) {
      const shown = copy.map((p) => `'${p}'`).join(", ") + (copy.length === 1 ? "," : "");
      throw new ValueError(`${name}(${shown}) -> ${returns} registered twice`);
    }
    overloads.push(new Overload(copy, returns, impl));
  }

  /** Decorator form of add(). */
  fn(name: string, params: readonly string[] = [], returns: string = "void"): (impl: Impl) => Impl {
    return (impl: Impl) => {
      this.add(name, params, returns, impl);
      return impl;
    };
  }

  /** `for v in <expression of type source> do`, v of type `var` ("any"
   * accepts any variable; impl then yields Typed values). */
  loop(source: string, var_: string, impl: Impl): void {
    this.loops.set(key(source, var_), impl);
  }

  /** `for v in owner -> "name" do` (arrow "->" or "<-"). */
  arrow(arrow: string, owner: string, var_: string, impl: Impl): void {
    this.arrows.set(key(arrow, owner, var_), impl);
  }

  /** What `left right` (written side by side) means for these types. */
  juxta(left: string, right: string, returns: string, impl: Impl): void {
    this.juxtas.set(key(left, right), [returns, impl]);
  }

  /** Binary operators and assignment forms ("=", "+=", "-=") for handle
   * types. For assignments `returns` is "void" and impl mutates `left`. */
  operator(op: string, left: string, right: string | null, returns: string, impl: Impl): void {
    this.operators.set(key(op, left, right), [returns, impl]);
  }

  index(base: string, index: string, returns: string, impl: Impl): void {
    this.indexes.set(key(base, index), [returns, impl]);
  }

  slice(base: string, returns: string, impl: Impl): void {
    this.slices.set(base, [returns, impl]);
  }

  /** `x.name` where x is of type `owner` (e.g. AttrDef .name). */
  prop(owner: string, name: string, returns: string, getter: Impl, setter: Impl | null = null): void {
    this.properties.set(key(owner, name), [returns, getter, setter]);
  }

  /** Make `x."name"` work for x of type `owner`. Values cross as text;
   * booleans arrive at the setter as "True"/"False". */
  attributes(owner: string, getter: Impl, setter: Impl): void {
    this.attrs.set(owner, [getter, setter]);
  }
}

export function same_params(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

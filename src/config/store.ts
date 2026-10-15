/** Pure helpers for the config tree: clone, path access, overrides and diffs. No DOM. */

export type ConfigValue = number | string | boolean | ConfigValue[] | ConfigTree;
export interface ConfigTree {
  [key: string]: ConfigValue;
}

export function isTree(v: unknown): v is ConfigTree {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepClone<T>(v: T): T {
  return structuredClone(v);
}

export function getPath(tree: ConfigTree, path: string): ConfigValue | undefined {
  let node: ConfigValue | undefined = tree;
  for (const key of path.split('.')) {
    if (!isTree(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** Sets a leaf value. Returns false (and changes nothing) if the path doesn't exist or types differ. */
export function setPath(tree: ConfigTree, path: string, value: ConfigValue): boolean {
  const keys = path.split('.');
  const last = keys.pop();
  if (last === undefined) return false;
  let node: ConfigValue | undefined = tree;
  for (const key of keys) {
    if (!isTree(node)) return false;
    node = node[key];
  }
  if (!isTree(node) || !(last in node)) return false;
  const current = node[last];
  if (current === undefined || !sameShape(current, value)) return false;
  node[last] = deepClone(value);
  return true;
}

function sameShape(a: ConfigValue, b: ConfigValue): boolean {
  if (Array.isArray(a)) return Array.isArray(b);
  if (isTree(a)) return false; // only leaves are settable
  return typeof a === typeof b;
}

/** Flattens leaves to dotted paths. Arrays count as leaves. */
export function flatten(tree: ConfigTree, prefix = '', out: Record<string, ConfigValue> = {}) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isTree(value)) flatten(value, path, out);
    else out[path] = value;
  }
  return out;
}

/** Leaves in `current` that differ from `defaults`. */
export function diff(defaults: ConfigTree, current: ConfigTree): Record<string, ConfigValue> {
  const a = flatten(defaults);
  const b = flatten(current);
  const out: Record<string, ConfigValue> = {};
  for (const [path, value] of Object.entries(b)) {
    if (JSON.stringify(a[path]) !== JSON.stringify(value)) out[path] = value;
  }
  return out;
}

/** Applies flat overrides; unknown or mistyped paths are skipped and returned. */
export function applyOverrides(tree: ConfigTree, overrides: Record<string, unknown>): string[] {
  const rejected: string[] = [];
  for (const [path, value] of Object.entries(overrides)) {
    if (!setPath(tree, path, value as ConfigValue)) rejected.push(path);
  }
  return rejected;
}

/** Copies every leaf from `source` into `target` in place (keeps object identity for bindings). */
export function assignInPlace(target: ConfigTree, source: ConfigTree) {
  for (const [key, value] of Object.entries(source)) {
    const t = target[key];
    if (isTree(value) && isTree(t)) assignInPlace(t, value);
    else target[key] = deepClone(value);
  }
}

/** Debug-panel metadata for a config value, keyed by dotted path (e.g. "sun.elevationDeg"). */
export interface ConfigMeta {
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  /** Options for a dropdown: label -> value. */
  options?: Record<string, string | number>;
  /** Only takes effect after a reload. */
  reload?: boolean;
  /** Show but don't allow edits. */
  readonly?: boolean;
  /** Hide from the debug panel entirely. */
  hidden?: boolean;
}

export type MetaMap = Record<string, ConfigMeta>;

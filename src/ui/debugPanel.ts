import { Pane, type FolderApi } from 'tweakpane';
import { asTree, changedValues, config, meta, resetConfig, saveOverrides } from '../config';
import { isTree, setPath, type ConfigTree, type ConfigValue } from '../config/store';
import { events } from '../core/events';

type Container = Pane | FolderApi;

export interface DebugActions {
  spawnTestBodies(): void;
  clearTestBodies(): void;
  resetCamera(): void;
  teleport(x: number, y: number, z: number): void;
  toggleFullscreen(): void;
  /** Cut every column of the story under the reticle (structural test). */
  cutStory(): boolean;
  startFire(): boolean;
  toggleNight(): void;
}

/**
 * Debug panel (F1): every config value, generated from the config tree + meta, plus tool buttons.
 * Changes apply live, persist to localStorage, and "Copy changed values" exports them.
 */
export class DebugPanel {
  readonly container: HTMLDivElement;
  private pane: Pane;

  constructor(parent: HTMLElement, seed: number, actions: DebugActions) {
    this.container = document.createElement('div');
    this.container.id = 'debug-panel';
    parent.appendChild(this.container);
    this.pane = new Pane({ container: this.container, title: 'GROUND ZERO debug (F1)' });
    this.visible = false;

    this.buildTools(seed, actions);
    const tree = asTree(config);
    for (const [key, value] of Object.entries(tree)) {
      if (!isTree(value)) continue;
      const folder = this.pane.addFolder({ title: key, expanded: false });
      this.buildFolder(folder, value, key);
    }
  }

  get visible() {
    return !this.pane.hidden;
  }

  set visible(v: boolean) {
    this.pane.hidden = !v;
    this.container.style.display = v ? '' : 'none';
  }

  toggle() {
    this.visible = !this.visible;
    if (this.visible) document.exitPointerLock?.();
  }

  private buildTools(seed: number, actions: DebugActions) {
    const f = this.pane.addFolder({ title: 'tools', expanded: true });
    f.addButton({ title: 'Spawn test bodies' }).on('click', () => actions.spawnTestBodies());
    f.addButton({ title: 'Clear test bodies' }).on('click', () => actions.clearTestBodies());
    f.addButton({ title: 'Reset camera' }).on('click', () => actions.resetCamera());
    f.addButton({ title: 'Cut supports under reticle' }).on('click', () => actions.cutStory());
    f.addButton({ title: 'Start fire under reticle' }).on('click', () => actions.startFire());
    f.addButton({ title: 'Toggle day / night' }).on('click', () => actions.toggleNight());

    const tp = { x: 0, y: 50, z: 0 };
    const tpf = f.addFolder({ title: 'teleport', expanded: false });
    tpf.addBinding(tp, 'x', { step: 1 });
    tpf.addBinding(tp, 'y', { step: 1 });
    tpf.addBinding(tp, 'z', { step: 1 });
    tpf.addButton({ title: 'Go' }).on('click', () => actions.teleport(tp.x, tp.y, tp.z));

    const seedObj = { seed };
    f.addBinding(seedObj, 'seed', { step: 1, label: 'seed' });
    f.addButton({ title: 'Reset city (same seed)' }).on('click', () => reloadWithSeed(seed));
    f.addButton({ title: 'Load seed above' }).on('click', () =>
      reloadWithSeed(Math.trunc(seedObj.seed)),
    );
    f.addButton({ title: 'New random seed' }).on('click', () =>
      reloadWithSeed(Math.floor((performance.now() * 7919) % 1_000_000)),
    );
    f.addButton({ title: 'Quality: High (reload)' }).on('click', () =>
      this.applyPreset(QUALITY_HIGH),
    );
    f.addButton({ title: 'Quality: Low / laptop (reload)' }).on('click', () =>
      this.applyPreset(QUALITY_LOW),
    );
    f.addButton({ title: 'Fullscreen (captures Ctrl+W)' }).on('click', () =>
      actions.toggleFullscreen(),
    );
    f.addButton({ title: 'Copy changed values' }).on('click', () => {
      const text = JSON.stringify(changedValues(), null, 2);
      void navigator.clipboard?.writeText(text).catch(() => undefined);
      console.info('[config] changed values:\n' + text);
    });
    f.addButton({ title: 'Reset all to defaults' }).on('click', () => {
      resetConfig();
      this.pane.refresh();
      events.emit('config:changed', { path: '*' });
    });
  }

  private buildFolder(folder: Container, node: ConfigTree, prefix: string) {
    for (const [key, value] of Object.entries(node)) {
      const path = `${prefix}.${key}`;
      const m = meta[path] ?? {};
      if (m.hidden) continue;
      if (isTree(value)) {
        this.buildFolder(folder.addFolder({ title: key, expanded: false }), value, path);
        continue;
      }
      const label = (m.label ?? key) + (m.reload ? ' ⟳' : '');
      if (Array.isArray(value)) {
        this.addArrayBinding(folder, node, key, path, label);
        continue;
      }
      const params: Record<string, unknown> = { label };
      if (m.min !== undefined) params.min = m.min;
      if (m.max !== undefined) params.max = m.max;
      if (m.step !== undefined) params.step = m.step;
      if (m.options) params.options = m.options;
      if (m.readonly) params.readonly = true;
      folder.addBinding(node, key, params).on('change', () => this.changed(path));
    }
  }

  /** Arrays (e.g. key bindings) edit as comma-separated text. */
  private addArrayBinding(
    folder: Container,
    node: ConfigTree,
    key: string,
    path: string,
    label: string,
  ) {
    const arr = node[key] as ConfigValue[];
    const numeric = arr.length > 0 && typeof arr[0] === 'number';
    const proxy = { text: arr.join(', ') };
    folder.addBinding(proxy, 'text', { label }).on('change', () => {
      const parts = proxy.text
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const next = numeric ? parts.map(Number).filter(Number.isFinite) : parts;
      if (setPath(asTree(config), path, next)) this.changed(path);
    });
  }

  private applyPreset(preset: Record<string, ConfigValue>) {
    for (const [path, value] of Object.entries(preset)) setPath(asTree(config), path, value);
    saveOverrides();
    location.reload();
  }

  private changed(path: string) {
    saveOverrides();
    events.emit('config:changed', { path });
  }
}

/** Stopgap presets until the full quality system (M11). High = config defaults. */
const QUALITY_HIGH: Record<string, ConfigValue> = {
  'render.msaaSamples': 4,
  'render.bloom.enabled': true,
  'render.shadows.enabled': true,
  'render.shadows.mapSize': 2048,
  'render.shadows.cascades': 3,
  'render.maxPixelRatio': 1.5,
  'interiors.realLights': 2,
  'fire.lights': 3,
};
const QUALITY_LOW: Record<string, ConfigValue> = {
  'render.msaaSamples': 0,
  'render.bloom.enabled': false,
  'render.shadows.enabled': true,
  'render.shadows.mapSize': 1024,
  'render.shadows.cascades': 2,
  'render.maxPixelRatio': 1,
  'interiors.realLights': 0,
  'fire.lights': 0,
};

function reloadWithSeed(seed: number) {
  const url = new URL(location.href);
  url.searchParams.set('seed', String(seed));
  location.href = url.toString();
}

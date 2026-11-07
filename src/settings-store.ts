// One place to read and write every setting: bb's settings list (the
// declared SETTINGS) and the plugin's own (PLUGIN_SETTINGS, one kv key).
// The rest of the plugin reads merged values and doesn't care where a value
// lives; writes check everything first and then save all of it or nothing.
import type { BbPluginApi, PluginKvStorage, PluginSettingDescriptor, PluginSettingValue, PluginSettingsHandle } from "@get-bb/plugin-sdk";
import {
  ALL_SETTINGS,
  BOTH_AGENTS_ONLY,
  BOTH_AGENTS_REASON,
  NUMBER_RANGES,
  PLUGIN_SETTINGS,
  SETTINGS,
  SETTING_SECTIONS,
  crossFieldProblems,
  isDeclaredKey,
  isPluginKey,
  settingProblem,
  type DeclaredValues,
  type PluginKey,
  type PluginSettingSpec,
  type PluginValues,
  type SettingKey,
  type SettingSection,
  type SettingsValues,
} from "./settings.ts";

/** kv key of the plugin's own settings (only values that were set; defaults come from the code). */
export const PLUGIN_SETTINGS_KEY = "pluginSettings";
/** A complete validated snapshot also acts as the second-generation marker. */
export const DECLARED_SETTINGS_KEY = "declaredSettingsV1";

function declaredValues(raw: unknown): DeclaredValues | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const values = raw as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(SETTINGS)) {
    if (settingProblem(key, descriptor, values[key]) !== null) return null;
  }
  return Object.fromEntries(Object.keys(SETTINGS).map((key) => [key, values[key]])) as DeclaredValues;
}

/**
 * SDK-only migration across two plugin generations. The first keeps every
 * legacy descriptor readable and snapshots its effective values. On the next
 * reload the host renders no declared fields; the same controls use our KV.
 * No reload is initiated here: the installer/owner controls plugin lifecycle.
 */
export async function createMigratingSettingsStore(bb: BbPluginApi): Promise<SettingsStore> {
  const snapshot = await bb.storage.kv.get<unknown>(DECLARED_SETTINGS_KEY);
  if (snapshot === undefined) {
    const handle = bb.settings.define(SETTINGS);
    let saved = "";
    let writes: Promise<unknown> = Promise.resolve();
    const mirror = (values: DeclaredValues): Promise<unknown> => {
      const valid = declaredValues(values);
      if (valid === null) throw new Error("Cannot migrate invalid Boat settings.");
      const text = JSON.stringify(valid);
      if (text === saved) return writes;
      saved = text;
      writes = writes.catch(() => undefined).then(() => bb.storage.kv.set(DECLARED_SETTINGS_KEY, valid)).catch((error) => { saved = ""; throw error; });
      return writes;
    };
    await mirror(await handle.get());
    handle.onChange((values) => { void mirror(values).catch((error) => bb.log.warn(`settings migration: ${String(error)}`)); });
    const mirrored: PluginSettingsHandle<typeof SETTINGS> = {
      async get() { const values = await handle.get(); await mirror(values); return values; },
      async experimental_set(patch) { const values = await handle.experimental_set(patch); await mirror(values); return values; },
      onChange: (listener) => handle.onChange(listener),
    };
    return createSettingsStore(mirrored, bb.storage.kv);
  }
  // A corrupted snapshot is a blocking error, never permission to silently
  // replace the owner's migrated choices with defaults or stale host values.
  if (declaredValues(snapshot) === null) throw new Error("Boat settings could not be read. Restore the settings backup before reloading.");
  bb.settings.define({});
  const listeners: ((next: DeclaredValues, previous: DeclaredValues) => void)[] = [];
  const read = async () => {
    const values = declaredValues(await bb.storage.kv.get(DECLARED_SETTINGS_KEY));
    if (values === null) throw new Error("Boat settings could not be read. Restore the settings backup.");
    return values;
  };
  const handle: PluginSettingsHandle<typeof SETTINGS> = {
    get: read,
    async experimental_set(patch) {
      const previous = await read();
      const next = { ...previous };
      for (const [key, value] of Object.entries(patch)) {
        if (!isDeclaredKey(key)) throw new Error(`Unknown setting ${key}`);
        const problem = value === null ? null : settingProblem(key, SETTINGS[key], value);
        if (problem !== null) throw new Error(problem);
        (next as Record<string, PluginSettingValue>)[key] = value ?? SETTINGS[key].default;
      }
      await bb.storage.kv.set(DECLARED_SETTINGS_KEY, next);
      for (const listener of listeners) listener(next, previous);
      return next;
    },
    onChange: (listener) => { listeners.push(listener); },
  };
  return createSettingsStore(handle, bb.storage.kv, { declaredInPlugin: true });
}

/** Values that can't be saved; nothing was written. One line per problem. */
export class SettingsError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

/** Settings a rule across fields ties together (checked when either changes). */
const RELAY_RULE_KEYS = ["relaySwitchAt", "relaySwitchBackBelow"];

/** A change to write: a value, or null for the default. */
export type SettingsPatch = Record<string, PluginSettingValue | null>;

export interface SettingsStore {
  readonly declaredInPlugin: boolean;
  /** Every setting: bb's list first, then the plugin's own. */
  readonly descriptors: Record<string, PluginSettingDescriptor>;
  /** Every setting's effective value. */
  get(): Promise<SettingsValues>;
  /** Check every value (and the rules across them), then write them all; null: back to the default. */
  set(values: SettingsPatch): Promise<SettingsValues>;
  /** bb: bb's settings list; plugin: the plugin's own settings; null: no such setting. */
  where(key: string): "bb" | "plugin" | null;
  /** After any change, from here or from bb's settings page (keys that changed). */
  onChange(listener: (keys: string[]) => void): void;
}

/** The plugin's own values: stored ones that are still valid, defaults for the rest. */
export function pluginValues(stored: unknown): PluginValues {
  const record = stored !== null && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const values: Record<string, PluginSettingValue> = {};
  for (const [key, descriptor] of Object.entries(PLUGIN_SETTINGS) as [PluginKey, (typeof PLUGIN_SETTINGS)[PluginKey]][]) {
    const value = record[key];
    values[key] = value !== undefined && settingProblem(key, descriptor, value) === null ? (value as PluginSettingValue) : descriptor.default;
  }
  return values as PluginValues;
}

function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

export function createSettingsStore(handle: PluginSettingsHandle<typeof SETTINGS>, kv: PluginKvStorage, options: { declaredInPlugin?: boolean } = {}): SettingsStore {
  /** Stored plugin values (only what was set); read once, then kept here (only this plugin writes it). */
  let stored: Record<string, PluginSettingValue> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const listeners: ((keys: string[]) => void)[] = [];

  /**
   * The stored values. A failed read gives the defaults for now (and is
   * tried again next time); a write reads strictly, so it never replaces
   * values it couldn't see.
   */
  async function readStored(strict = false): Promise<Record<string, PluginSettingValue>> {
    if (stored !== null) return stored;
    let raw: unknown;
    try {
      raw = await kv.get<unknown>(PLUGIN_SETTINGS_KEY);
    } catch (error) {
      if (strict) throw error;
      return {};
    }
    const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    // Keep only the values this version knows and accepts.
    const valid = pluginValues(record);
    stored = Object.fromEntries(Object.keys(record).filter((key) => isPluginKey(key) && record[key] === valid[key]).map((key) => [key, valid[key as PluginKey]]));
    return stored;
  }

  function emit(keys: string[]): void {
    if (keys.length === 0) return;
    for (const listener of listeners) {
      try {
        listener(keys);
      } catch {
        // A listener's failure doesn't undo the change.
      }
    }
  }

  handle.onChange((next, prev) => emit(changedKeys(prev, next)));

  async function get(): Promise<SettingsValues> {
    const [declared, own] = await Promise.all([handle.get(), readStored()]);
    return { ...(declared as DeclaredValues), ...pluginValues(own) };
  }

  async function write(values: SettingsPatch): Promise<SettingsValues> {
    const problems: string[] = [];
    const declared: Record<string, PluginSettingValue | null> = {};
    const own: Record<string, PluginSettingValue | null> = {};
    for (const [key, value] of Object.entries(values)) {
      if (!isDeclaredKey(key) && !isPluginKey(key)) {
        problems.push(`There's no setting "${key}".`);
        continue;
      }
      const problem = value === null ? null : settingProblem(key, ALL_SETTINGS[key], value);
      if (problem !== null) {
        problems.push(`${problem}${problem.endsWith(".") ? "" : "."}`);
        continue;
      }
      (isDeclaredKey(key) ? declared : own)[key] = value;
    }
    if (problems.length === 0 && RELAY_RULE_KEYS.some((key) => Object.hasOwn(values, key))) {
      // The rule across Switch at and Switch back below, on the values as they would be.
      const next = { ...(await get()) } as Record<string, PluginSettingValue>;
      for (const [key, value] of Object.entries(values)) next[key] = value ?? (ALL_SETTINGS[key as keyof typeof ALL_SETTINGS].default as PluginSettingValue);
      problems.push(...crossFieldProblems(next as unknown as PluginValues));
    }
    if (problems.length > 0) throw new SettingsError(problems);

    // Read the plugin's own first (a failed read writes nothing), then bb's
    // list: bb checks again and may refuse, and then nothing is written.
    const current = Object.keys(own).length > 0 ? await readStored(true) : null;
    if (Object.keys(declared).length > 0) await handle.experimental_set(declared as Parameters<typeof handle.experimental_set>[0]);
    if (current !== null) {
      const before = pluginValues(current);
      const nextStored = { ...current };
      for (const [key, value] of Object.entries(own)) {
        if (value === null) delete nextStored[key];
        else nextStored[key] = value;
      }
      await kv.set(PLUGIN_SETTINGS_KEY, nextStored);
      stored = nextStored;
      emit(changedKeys(before, pluginValues(nextStored)));
    }
    return get();
  }

  return {
    declaredInPlugin: options.declaredInPlugin === true,
    descriptors: ALL_SETTINGS,
    get,
    set(values) {
      // One write at a time, so two saves never lose each other's values.
      const run = queue.then(() => write(values));
      queue = run.catch(() => undefined);
      return run;
    },
    where(key) {
      return isDeclaredKey(key) ? options.declaredInPlugin ? "plugin" : "bb" : isPluginKey(key) ? "plugin" : null;
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}

// ---------------------------------------------------------------- rows for the UI and the CLI

export interface SettingRow {
  key: string;
  label: string;
  description: string;
  where: "bb" | "plugin";
  section: SettingSection | null;
  group: string | null;
  fold: string | null;
  type: "boolean" | "number" | "string" | "select";
  value: PluginSettingValue;
  default: PluginSettingValue;
  isDefault: boolean;
  options: { value: string; label: string }[] | null;
  min: number | null;
  max: number | null;
  integer: boolean;
  multiline: boolean;
  disabledReason: string | null;
}

/** Every setting as a row: bb's list first, then the plugin's own in section order. */
export function settingRows(values: SettingsValues, context: { onlyAgent: string | null; declaredInPlugin?: boolean }): SettingRow[] {
  const sectionOrder = SETTING_SECTIONS.map((section) => section.id as string);
  const rows = (Object.entries(ALL_SETTINGS) as [SettingKey, PluginSettingDescriptor][]).map(([key, descriptor]): SettingRow => {
    const spec = isPluginKey(key) ? (PLUGIN_SETTINGS[key] as PluginSettingSpec) : null;
    const value = values[key] as PluginSettingValue;
    const fallback = descriptor.default as PluginSettingValue;
    const range = (NUMBER_RANGES as Record<string, { min: number; max: number; integer: boolean }>)[key] ?? null;
    return {
      key,
      label: descriptor.label,
      description: descriptor.description ?? "",
      where: spec === null && !context.declaredInPlugin ? "bb" : "plugin",
      section: spec?.section ?? (context.declaredInPlugin ? key === "pushNotifications" ? "usage-limits" : ["agents", "implementProvider", "reviewProvider"].includes(key) ? "models" : "advanced" : null),
      group: spec?.group ?? null,
      fold: spec?.fold ?? null,
      type: descriptor.type === "project" ? "string" : descriptor.type,
      value,
      default: fallback,
      isDefault: value === fallback,
      options:
        descriptor.type === "select" ? descriptor.options.map((option) => ({ value: option, label: descriptor.experimental_optionLabels?.[option] ?? option })) : null,
      min: range?.min ?? null,
      max: range?.max ?? null,
      integer: range?.integer ?? false,
      multiline: descriptor.type === "string" && descriptor.experimental_multiline === true,
      disabledReason: context.onlyAgent !== null && (BOTH_AGENTS_ONLY as readonly string[]).includes(key) ? BOTH_AGENTS_REASON : null,
    };
  });
  // Stable: bb's list keeps its order, the plugin's own go section by section.
  const rank = (row: SettingRow) => (row.section === null ? -1 : sectionOrder.indexOf(row.section));
  return rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index).map(({ row }) => row);
}

function shown(value: PluginSettingValue): string {
  if (typeof value !== "string") return String(value);
  if (value === "") return "(empty)";
  const lines = value.split("\n");
  const first = lines[0]!.length > 60 ? `${lines[0]!.slice(0, 59)}…` : lines[0]!;
  return lines.length > 1 ? `${JSON.stringify(`${first}…`)} (${lines.length} lines)` : JSON.stringify(first);
}

/** The rows as text (`bb boat config get`): bb's list, then each plugin section. */
export function settingsText(rows: SettingRow[]): string {
  const blocks: string[] = [];
  const line = (row: SettingRow) =>
    `  ${row.key} = ${shown(row.value)}${row.isDefault ? "" : `  (default ${shown(row.default)})`}${row.disabledReason ? `  [${row.disabledReason.toLowerCase()}]` : ""}`;
  const bbRows = rows.filter((row) => row.where === "bb");
  if (bbRows.length > 0) blocks.push(["bb's settings list (Settings → Plugins → Boat Cloud Agents):", ...bbRows.map(line)].join("\n"));
  for (const section of SETTING_SECTIONS) {
    const inSection = rows.filter((row) => row.section === section.id);
    if (inSection.length > 0) blocks.push([`${section.title}:`, ...inSection.map(line)].join("\n"));
  }
  return blocks.join("\n\n");
}

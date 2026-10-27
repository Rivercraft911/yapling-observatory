import type { PlotId } from './registry';

export type PlotLayout = 'compact' | 'results';
export type PlotColumns = 'auto' | 1 | 2 | 3;
export interface PlotPreferences {
  selection: PlotId[];
  columns: PlotColumns;
  selectionPreset?: 'default' | 'link';
}
export const plotLayouts = {
  compact: {
    storageKey: 'ssi-workspace-plots',
    maximum: 6,
    defaults: ['pointing', 'margin', 'rate'] as PlotId[],
  },
  results: {
    storageKey: 'ssi-workspace-results-plots',
    maximum: 12,
    defaults: ['margin', 'rate', 'pointing', 'wheel_capacity', 'power', 'temperatures'] as PlotId[],
  },
};

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function defaultPlotSelection(layout: PlotLayout, adaptive: boolean): PlotId[] {
  if (!adaptive) return [...plotLayouts[layout].defaults];
  return layout === 'compact'
    ? ['selected_margin', 'frame_rate', 'pointing']
    : ['selected_margin', 'frame_rate', 'pointing', 'wheel_capacity', 'power', 'temperatures'];
}

export function linkPlotSelection(layout: PlotLayout, adaptive: boolean): PlotId[] {
  if (layout === 'compact') return defaultPlotSelection(layout, adaptive);
  return adaptive
    ? ['selected_margin', 'frame_rate', 'payload', 'receiver_lock', 'margin', 'rate']
    : ['margin', 'rate', 'payload', 'receiver_lock'];
}

export function effectivePlotSelection(
  preferences: PlotPreferences,
  layout: PlotLayout,
  adaptive: boolean,
): PlotId[] {
  return preferences.selectionPreset === 'default'
    ? defaultPlotSelection(layout, adaptive)
    : preferences.selectionPreset === 'link'
      ? linkPlotSelection(layout, adaptive)
      : preferences.selection;
}

export function readPlotPreferences(
  layout: PlotLayout,
  available: readonly PlotId[],
  storage?: PreferenceStorage,
): PlotPreferences {
  const settings = plotLayouts[layout];
  const fallback: PlotPreferences = {
    selection: [...settings.defaults],
    columns: 'auto',
    selectionPreset: 'default',
  };
  try {
    const saved: unknown = JSON.parse(storage?.getItem(settings.storageKey) || 'null');
    const record =
      saved && typeof saved === 'object' && !Array.isArray(saved)
        ? (saved as {
            version?: unknown;
            selection?: unknown;
            columns?: unknown;
            selectionPreset?: unknown;
          })
        : null;
    const selection =
      layout === 'compact' && Array.isArray(saved)
        ? saved
        : record?.version === 1
          ? record.selection
          : null;
    if (
      !Array.isArray(selection) ||
      selection.length < 1 ||
      selection.length > settings.maximum ||
      new Set(selection).size !== selection.length ||
      !selection.every((id) => available.includes(id))
    )
      return fallback;
    const columns =
      layout === 'results' &&
      (record?.columns === 1 || record?.columns === 2 || record?.columns === 3)
        ? record.columns
        : 'auto';
    const selectionPreset = record?.selectionPreset;
    return {
      selection: [...selection],
      columns,
      ...(selectionPreset === 'default' || selectionPreset === 'link' ? { selectionPreset } : {}),
    };
  } catch {
    return fallback;
  }
}

export function writePlotPreferences(
  layout: PlotLayout,
  preferences: PlotPreferences,
  storage?: PreferenceStorage,
) {
  try {
    storage?.setItem(
      plotLayouts[layout].storageKey,
      JSON.stringify(
        layout === 'compact' && !preferences.selectionPreset
          ? preferences.selection
          : { version: 1, ...preferences },
      ),
    );
  } catch {}
}

export function togglePlotSelection(selection: readonly PlotId[], id: PlotId, layout: PlotLayout) {
  return selection.includes(id)
    ? selection.length > 1
      ? selection.filter((value) => value !== id)
      : [...selection]
    : selection.length < plotLayouts[layout].maximum
      ? [...selection, id]
      : [...selection];
}

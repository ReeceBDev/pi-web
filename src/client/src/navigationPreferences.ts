export interface NavigationPreferences {
  // Tabs the user explicitly hid. Tabs never named here stay visible, so
  // plugins that add a new tab later (e.g. Workspace Tasks) are visible by
  // default instead of falling outside a stale "show only these" list.
  hiddenIds: string[];
  mobileCollapsed: boolean;
}

// v2: the old key stored materialized pin lists ("show only these"), which hid
// every tab added after the list was written. Start clean under a new key.
const storageKey = "pi-web:navigation-preferences-v2";

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadNavigationPreferences(storage: Pick<Storage, "getItem"> | undefined = browserStorage()): NavigationPreferences {
  try {
    const value: unknown = JSON.parse(storage?.getItem(storageKey) ?? "null");
    if (typeof value === "object" && value !== null) {
      const hidden: unknown = "hiddenIds" in value ? value.hiddenIds : undefined;
      return {
        hiddenIds: Array.isArray(hidden) ? [...new Set(hidden.filter((id): id is string => typeof id === "string" && id.length > 0))] : [],
        mobileCollapsed: "mobileCollapsed" in value && value.mobileCollapsed === true,
      };
    }
  } catch {
    // Layout preferences are optional when storage is blocked or malformed.
  }
  return { hiddenIds: [], mobileCollapsed: false };
}

export function saveNavigationPreferences(preferences: NavigationPreferences, storage: Pick<Storage, "setItem"> | undefined = browserStorage()): void {
  try {
    storage?.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    // Ignore quota/privacy errors for this optional browser layout preference.
  }
}

export function visibleNavigationTabs<T extends { id: string }>(tabs: readonly T[], hiddenIds: readonly string[]): T[] {
  return tabs.filter((tab) => !hiddenIds.includes(tab.id));
}

export function toggleNavigationTabHidden(id: string, hiddenIds: readonly string[]): string[] {
  return hiddenIds.includes(id) ? hiddenIds.filter((hidden) => hidden !== id) : [...hiddenIds, id];
}

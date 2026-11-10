import { describe, expect, it } from "vitest";
import { loadNavigationPreferences, saveNavigationPreferences, toggleNavigationTabHidden, visibleNavigationTabs } from "./navigationPreferences";

const tabs = [{ id: "navigation" }, { id: "chat" }, { id: "plugin:files" }];

describe("navigation preferences", () => {
  it("shows every tab unless it is explicitly hidden, in destination order", () => {
    expect(visibleNavigationTabs(tabs, [])).toEqual(tabs);
    expect(visibleNavigationTabs(tabs, ["plugin:files"])).toEqual([tabs[0], tabs[1]]);
    // A tab a user has never hidden (e.g. a newly added plugin tab) stays visible.
    expect(visibleNavigationTabs(tabs, ["navigation", "chat"])).toEqual([tabs[2]]);
  });

  it("toggles hidden membership both ways", () => {
    expect(toggleNavigationTabHidden("chat", [])).toEqual(["chat"]);
    expect(toggleNavigationTabHidden("chat", ["navigation", "chat"])).toEqual(["navigation"]);
    expect(toggleNavigationTabHidden("chat", ["chat"])).toEqual([]);
  });

  it("keeps hidden ids for tabs that are currently unavailable", () => {
    const hidden = ["missing:tool"];
    expect(visibleNavigationTabs(tabs, hidden)).toEqual(tabs);
    expect(visibleNavigationTabs([{ id: "missing:tool" }], hidden)).toEqual([]);
    expect(toggleNavigationTabHidden("missing:tool", hidden)).toEqual([]);
    expect(hidden).toEqual(["missing:tool"]);
  });

  it("round-trips hidden ids independently from mobile collapse", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const preferences = { hiddenIds: ["missing:tool"], mobileCollapsed: true };
    saveNavigationPreferences(preferences, storage);
    expect(loadNavigationPreferences(storage)).toEqual(preferences);
    saveNavigationPreferences({ ...preferences, mobileCollapsed: false }, storage);
    expect(loadNavigationPreferences(storage)).toEqual({ ...preferences, mobileCollapsed: false });
  });

  it("defaults safely for malformed or unavailable storage and validates stored values", () => {
    const storage = (raw: string) => ({ getItem: () => raw });
    expect(loadNavigationPreferences(storage("{"))).toEqual({ hiddenIds: [], mobileCollapsed: false });
    expect(loadNavigationPreferences(storage('{"hiddenIds":["chat",5,"chat",""],"mobileCollapsed":"true"}'))).toEqual({ hiddenIds: ["chat"], mobileCollapsed: false });
    const blocked = { getItem: () => { throw new Error("Blocked"); }, setItem: () => { throw new Error("Blocked"); } };
    expect(loadNavigationPreferences(blocked)).toEqual({ hiddenIds: [], mobileCollapsed: false });
    expect(() => { saveNavigationPreferences({ hiddenIds: [], mobileCollapsed: true }, blocked); }).not.toThrow();
  });
});

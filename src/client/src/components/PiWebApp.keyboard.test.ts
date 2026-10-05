// @vitest-environment happy-dom

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, SessionInfo } from "../api";
import { initialAppState, type AppState } from "../appState";
import { AuthDialog } from "./AuthDialog";
import { ChatView } from "./ChatView";
import { ModalSurface } from "./ModalSurface";
import { PiWebApp } from "./PiWebApp";
import { PromptEditor } from "./PromptEditor";
import type { TranscriptImage } from "./TranscriptImage";
import { settleImage } from "./imagePresentation.testSupport";

const IMAGE_DATA = "iVBORw0KGgo=";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp global shortcut modality boundary", () => {
  it("runs a global shortcut when the application has no rendered modal", async () => {
    const app = new PiWebApp();
    await waitForBuiltInPlugins(app);
    const target = appendKeyTarget();
    const targetKeyDown = vi.fn();
    target.addEventListener("keydown", targetKeyDown);

    const event = dispatchShortcutThroughApp(app, target);

    expect(actionPaletteIsOpen(app)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(targetKeyDown).not.toHaveBeenCalled();
  });

  it("lets a composer send binding override an app shortcut only inside the editor", async () => {
    const app = new PiWebApp();
    await waitForBuiltInPlugins(app);
    const editor = new PromptEditor();
    editor.shortcuts = { "composer.send.desktop": "mod+k", "composer.send.mobile": "mod+k" };
    editor.onSend = vi.fn();
    document.body.append(editor);
    await editor.updateComplete;
    Object.defineProperty(app, "promptEditor", { configurable: true, value: editor });
    editor.replaceText("Hello");
    const target = requiredElement(editor.view?.contentDOM, "composer input");

    dispatchShortcutThroughApp(app, target);
    expect(editor.onSend).toHaveBeenCalledOnce();
    expect(actionPaletteIsOpen(app)).toBe(false);
    dispatchShortcutThroughApp(app, target); // Empty composer still owns the combination.
    expect(actionPaletteIsOpen(app)).toBe(false);

    dispatchShortcutThroughApp(app, appendKeyTarget());
    expect(actionPaletteIsOpen(app)).toBe(true);
  });

  it("leaves capture-phase keyboard handling with a rendered shared modal", async () => {
    const app = new PiWebApp();
    const target = await openAuthenticationDialog(app);
    const targetKeyDown = vi.fn();
    target.addEventListener("keydown", targetKeyDown);

    const event = dispatchShortcutThroughApp(app, target);

    expect(actionPaletteIsOpen(app)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(targetKeyDown).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "native image zoom", open: openImageZoom },
    { name: "composed native dialog", open: openComposedNativeDialog },
  ])("leaves capture-phase keyboard handling with the $name", async ({ open }) => {
    const app = new PiWebApp();
    const target = await open(app);
    const targetKeyDown = vi.fn();
    target.addEventListener("keydown", targetKeyDown);

    const event = dispatchShortcutThroughApp(app, target);

    expect(actionPaletteIsOpen(app)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(targetKeyDown).toHaveBeenCalledOnce();
  });

  it("does not suppress shortcuts for session-scoped state that cannot render", async () => {
    const app = new PiWebApp();
    await waitForBuiltInPlugins(app);
    setAppState(app, { modelDialog: { instanceId: 1, origin: { machineId: "local", sessionId: "session-1", cwd: "/repo" }, title: "Select model", options: [], catalog: [] } });
    const target = appendKeyTarget();

    const event = dispatchShortcutThroughApp(app, target);

    expect(actionPaletteIsOpen(app)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not automatically focus the prompt while a rendered modal remains open", async () => {
    const app = new PiWebApp();
    const appShell: unknown = Reflect.get(app, "appShell");
    if (!isAutoFocusAppShell(appShell)) throw new Error("PiWebApp shell was unavailable");
    vi.spyOn(appShell, "shouldAutoFocusPrompt").mockReturnValue(true);

    expect(appShouldAutoFocusPrompt(app)).toBe(true);
    await openAuthenticationDialog(app);

    expect(appShouldAutoFocusPrompt(app)).toBe(false);
  });

  it("rechecks rendered modality before a delayed prompt focus takes effect", async () => {
    const app = new PiWebApp();
    setAppState(app, { mainView: "chat" });
    const focusInput = vi.fn();
    Object.defineProperty(app, "promptEditor", { configurable: true, value: { focusInput } });
    Object.defineProperty(app, "updateComplete", { configurable: true, value: Promise.resolve(true) });
    let frameCallback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    });

    const focusing = focusChatComposer(app);
    await vi.waitFor(() => { expect(frameCallback).toBeDefined(); });

    const surface = new ModalSurface();
    surface.initialFocus = "button";
    surface.innerHTML = "<button>Surviving modal</button>";
    document.body.append(surface);
    await surface.updateComplete;
    const modalButton = requiredElement(surface.querySelector<HTMLButtonElement>("button"), "surviving modal button");
    expect(document.activeElement).toBe(modalButton);

    frameCallback?.(performance.now());
    await focusing;

    expect(focusInput).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(modalButton);
  });
});

describe("PiWebApp prompt focus and chat scroll on view switch", () => {
  it("focuses the prompt after switching to chat when the auto-focus gate accepts", async () => {
    const app = new PiWebApp();
    vi.spyOn(appShellLayout(app), "shouldAutoFocusPrompt").mockReturnValue(true);
    setAppState(app, { mainView: "chat" });
    const focusInput = vi.fn();
    Object.defineProperty(app, "promptEditor", { configurable: true, value: { focusInput } });
    Object.defineProperty(app, "updateComplete", { configurable: true, value: Promise.resolve(true) });
    const frames = stubFrameRequests();

    const focusing = focusChatComposer(app);
    await vi.waitFor(() => { expect(frames.scheduled()).toBeGreaterThan(0); });
    frames.flush();
    await focusing;

    expect(focusInput).toHaveBeenCalledOnce();
  });

  it("skips the prompt focus when the auto-focus gate declines (mobile or PWA)", async () => {
    const app = new PiWebApp();
    vi.spyOn(appShellLayout(app), "shouldAutoFocusPrompt").mockReturnValue(false);
    setAppState(app, { mainView: "chat" });
    const focusInput = vi.fn();
    Object.defineProperty(app, "promptEditor", { configurable: true, value: { focusInput } });
    Object.defineProperty(app, "updateComplete", { configurable: true, value: Promise.resolve(true) });
    const frames = stubFrameRequests();

    const focusing = focusChatComposer(app);
    await vi.waitFor(() => { expect(frames.scheduled()).toBeGreaterThan(0); });
    frames.flush();
    await focusing;

    expect(focusInput).not.toHaveBeenCalled();
  });

  it("restores chat scroll after the chat view becomes visible with a selected session", async () => {
    const app = new PiWebApp();
    setAppState(app, { mainView: "navigation", selectedSession: session("session-scroll") });
    const restoreScrollPosition = vi.fn();
    Object.defineProperty(app, "chatView", { configurable: true, value: { restoreScrollPosition } });
    Object.defineProperty(app, "updateComplete", { configurable: true, value: Promise.resolve(true) });
    const frames = stubFrameRequests();

    selectMainView(app, "chat");
    await vi.waitFor(() => { expect(frames.scheduled()).toBeGreaterThan(0); });
    frames.flush();
    await vi.waitFor(() => { expect(restoreScrollPosition).toHaveBeenCalled(); });

    expect(restoreScrollPosition).toHaveBeenCalledOnce();
  });

  it("does not stack chat scroll restores when the view changes again mid-flight", async () => {
    const app = new PiWebApp();
    setAppState(app, { mainView: "navigation", selectedSession: session("session-scroll") });
    const restoreScrollPosition = vi.fn();
    Object.defineProperty(app, "chatView", { configurable: true, value: { restoreScrollPosition } });
    Object.defineProperty(app, "updateComplete", { configurable: true, value: Promise.resolve(true) });
    const frames = stubFrameRequests();

    selectMainView(app, "chat");
    selectMainView(app, "workspace");
    selectMainView(app, "chat");
    await settleMicrotasks();
    frames.flush();
    await vi.waitFor(() => { expect(restoreScrollPosition).toHaveBeenCalled(); });

    expect(restoreScrollPosition).toHaveBeenCalledOnce();
  });

  it("does not schedule a chat scroll restore when chat is already shown or no session is selected", async () => {
    const app = new PiWebApp();
    const restoreScrollPosition = vi.fn();
    Object.defineProperty(app, "chatView", { configurable: true, value: { restoreScrollPosition } });
    Object.defineProperty(app, "updateComplete", { configurable: true, value: Promise.resolve(true) });
    const frames = stubFrameRequests();

    setAppState(app, { mainView: "chat", selectedSession: session("session-scroll") });
    selectMainView(app, "chat");
    await settleMicrotasks();

    setAppState(app, { mainView: "navigation" });
    selectMainView(app, "chat");
    await settleMicrotasks();

    expect(frames.scheduled()).toBe(0);
    expect(restoreScrollPosition).not.toHaveBeenCalled();
  });

  it("sends project selection to chat on mobile and to workspaces on desktop", () => {
    const project = testProject("p1");

    const mobileApp = new PiWebApp();
    appShellLayout(mobileApp).isMobileNavigationLayout = true;
    const mobileSelect = stubSelectNavigationItem(mobileApp);
    navigationActionsOf(mobileApp).selectProject(project);
    expect(mobileSelect.mock.calls[0]?.[0]).toBe("projects");
    expect(mobileSelect.mock.calls[0]?.[1]).toBe("chat");

    const desktopApp = new PiWebApp();
    appShellLayout(desktopApp).isMobileNavigationLayout = false;
    const desktopSelect = stubSelectNavigationItem(desktopApp);
    navigationActionsOf(desktopApp).selectProject(project);
    expect(desktopSelect.mock.calls[0]?.[0]).toBe("projects");
    expect(desktopSelect.mock.calls[0]?.[1]).toBe("workspaces");
  });
});

type AppKeyDownHandler = (event: KeyboardEvent) => void;
type FocusChatComposer = (this: PiWebApp) => Promise<void>;

interface AutoFocusAppShell {
  shouldAutoFocusPrompt: () => boolean;
}

async function waitForBuiltInPlugins(app: PiWebApp): Promise<void> {
  const ready: unknown = Reflect.get(app, "builtInPluginsReady");
  if (!(ready instanceof Promise)) throw new Error("PiWebApp built-in plugin readiness was unavailable");
  await ready;
}

function dispatchShortcutThroughApp(app: PiWebApp, target: HTMLElement): KeyboardEvent {
  const handler: unknown = Reflect.get(app, "onKeyDown");
  if (!isAppKeyDownHandler(handler)) throw new Error("PiWebApp shortcut handler was unavailable");
  window.addEventListener("keydown", handler, { capture: true });
  const event = new KeyboardEvent("keydown", {
    key: "k",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  try {
    target.dispatchEvent(event);
  } finally {
    window.removeEventListener("keydown", handler, { capture: true });
  }
  return event;
}

async function openAuthenticationDialog(app: PiWebApp): Promise<HTMLElement> {
  setAppState(app, { authDialog: { step: "method", machineId: "local" } });
  const container = renderApp(app);
  const dialog = requiredElement(container.querySelector<AuthDialog>("auth-dialog"), "authentication dialog");
  await dialog.updateComplete;
  const surface = requiredElement(dialog.shadowRoot?.querySelector<ModalSurface>("modal-surface"), "authentication modal surface");
  await surface.updateComplete;
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLElement>("button[aria-label='Close']"), "authentication close button");
}

async function openImageZoom(app: PiWebApp): Promise<HTMLElement> {
  const selectedSession = session("session-image");
  setAppState(app, {
    selectedSession,
    sessions: [selectedSession],
    mainView: "chat",
    messages: [{ role: "user", parts: [{ type: "image", mimeType: "image/png", data: IMAGE_DATA }] }],
  });
  const container = renderApp(app);
  const view = requiredElement(container.querySelector<ChatView>("chat-view"), "chat view");
  await view.updateComplete;
  expect(view.sessionCwd).toBe(selectedSession.cwd);
  const transcript = requiredElement(view.renderRoot.querySelector<TranscriptImage>("pi-web-transcript-image"), "transcript image");
  const presentation = await settleImage(transcript);
  presentation.renderRoot.querySelector<HTMLButtonElement>(".placeholder")?.click();
  await settleImage(transcript);
  requiredElement(presentation.renderRoot.querySelector("img"), "native image").dispatchEvent(new Event("load"));
  await presentation.updateComplete;
  const image = requiredElement(presentation.renderRoot.querySelector<HTMLButtonElement>(".image-button"), "image trigger");
  image.focus();
  image.click();
  await view.updateComplete;
  const dialog = requiredElement(view.shadowRoot?.querySelector<HTMLDialogElement>("dialog.image-zoom"), "image zoom dialog");
  expect(dialog.open).toBe(true);
  return requiredElement(dialog.querySelector<HTMLElement>(".image-zoom-close"), "image zoom close button");
}

function openComposedNativeDialog(): Promise<HTMLElement> {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  const dialog = document.createElement("dialog");
  const button = document.createElement("button");
  button.textContent = "Plugin modal action";
  dialog.append(button);
  root.append(dialog);
  document.body.append(host);
  dialog.showModal();
  button.focus();
  return Promise.resolve(button);
}

function renderApp(app: PiWebApp): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(app.render(), container);
  return container;
}

function focusChatComposer(app: PiWebApp): Promise<void> {
  const method: unknown = Reflect.get(app, "focusChatComposer");
  if (!isFocusChatComposer(method)) throw new Error("PiWebApp prompt focus boundary was unavailable");
  return Reflect.apply(method, app, []);
}

function isFocusChatComposer(value: unknown): value is FocusChatComposer {
  return typeof value === "function";
}

function isAppKeyDownHandler(value: unknown): value is AppKeyDownHandler {
  return typeof value === "function";
}

function isAutoFocusAppShell(value: unknown): value is AutoFocusAppShell {
  return typeof value === "object" && value !== null && "shouldAutoFocusPrompt" in value
    && typeof value.shouldAutoFocusPrompt === "function";
}

function appShouldAutoFocusPrompt(app: PiWebApp): boolean {
  const decision: unknown = Reflect.get(app, "shouldAutoFocusPrompt");
  if (typeof decision !== "function") throw new Error("PiWebApp auto-focus decision was unavailable");
  const result: unknown = Reflect.apply(decision, app, []);
  if (typeof result !== "boolean") throw new Error("PiWebApp auto-focus decision was invalid");
  return result;
}

function actionPaletteIsOpen(app: PiWebApp): boolean {
  const state: unknown = Reflect.get(app, "state");
  if (typeof state !== "object" || state === null || !("actionPaletteOpen" in state) || typeof state.actionPaletteOpen !== "boolean") {
    throw new Error("PiWebApp action-palette state was unavailable");
  }
  return state.actionPaletteOpen;
}

function setAppState(app: PiWebApp, patch: Partial<AppState>): void {
  if (!Reflect.set(app, "state", { ...initialAppState(), ...patch })) throw new Error("Could not set PiWebApp state");
}

interface AppShellLayout {
  isMobileNavigationLayout: boolean;
  shouldAutoFocusPrompt: () => boolean;
}

function appShellLayout(app: PiWebApp): AppShellLayout {
  const shell: unknown = Reflect.get(app, "appShell");
  if (!isAppShellLayout(shell)) throw new Error("PiWebApp app shell was unavailable");
  return shell;
}

function isAppShellLayout(value: unknown): value is AppShellLayout {
  return typeof value === "object" && value !== null && "isMobileNavigationLayout" in value
    && "shouldAutoFocusPrompt" in value && typeof value.shouldAutoFocusPrompt === "function";
}

function stubFrameRequests(): { flush: () => void; scheduled: () => number } {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  return {
    flush: () => { for (const callback of callbacks.splice(0)) callback(performance.now()); },
    scheduled: () => callbacks.length,
  };
}

function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

type SelectMainView = (this: PiWebApp, view: AppState["mainView"]) => void;

function selectMainView(app: PiWebApp, view: AppState["mainView"]): void {
  const method: unknown = Reflect.get(app, "selectMainView");
  if (!isSelectMainView(method)) throw new Error("PiWebApp main-view switch was unavailable");
  Reflect.apply(method, app, [view]);
}

function isSelectMainView(value: unknown): value is SelectMainView {
  return typeof value === "function";
}

function stubSelectNavigationItem(app: PiWebApp): ReturnType<typeof vi.fn> {
  const selection = vi.fn();
  Object.defineProperty(app, "selectNavigationItem", { configurable: true, value: selection });
  return selection;
}

function navigationActionsOf(app: PiWebApp): { selectProject: (project: Project) => unknown } {
  const actions: unknown = Reflect.get(app, "navigationActions");
  if (!isNavigationActions(actions)) throw new Error("PiWebApp navigation actions were unavailable");
  return actions;
}

function isNavigationActions(value: unknown): value is { selectProject: (project: Project) => unknown } {
  return typeof value === "object" && value !== null && "selectProject" in value
    && typeof value.selectProject === "function";
}

function testProject(id: string): Project {
  return { id, name: id, path: `/repo/${id}`, createdAt: "2026-07-20T00:00:00.000Z" };
}

function appendKeyTarget(): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = "Modal action";
  document.body.append(button);
  return button;
}

function requiredElement<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}

function session(id: string): SessionInfo {
  return {
    id,
    cwd: "/repo",
    path: `/repo/${id}.jsonl`,
    created: "2026-07-20T00:00:00.000Z",
    modified: "2026-07-20T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
  };
}

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearStagedAttachments } from "../promptAttachmentStaging";
import { PromptEditor } from "./PromptEditor";
import type { DictationController, DictationEvents } from "../speech/dictation";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

interface FakeDictation {
  emitPartial: (text: string) => void;
  failStart: (message: string) => void;
  finished: number;
  cancelled: number;
  controller: DictationController;
}

function newFake(): FakeDictation {
  const fake: FakeDictation = {
    emitPartial: () => { /* wired by createEditor */ },
    failStart: () => { /* wired by createEditor */ },
    finished: 0,
    cancelled: 0,
    controller: {
      finish: () => {
        fake.finished += 1;
        return Promise.resolve("final words");
      },
      cancel: () => { fake.cancelled += 1; },
    },
  };
  return fake;
}

function createEditor(fake: FakeDictation): PromptEditor {
  const editor = new PromptEditor();
  editor.machineId = "local";
  editor.sessionId = "session-a";
  let startFailure: string | undefined;
  let partialSink: ((text: string) => void) | undefined;
  editor.createDictation = (events: DictationEvents) => {
    partialSink = events.onPartial;
    if (startFailure !== undefined) return Promise.reject(new Error(startFailure));
    return Promise.resolve(fake.controller);
  };
  fake.emitPartial = (text: string) => { partialSink?.(text); };
  fake.failStart = (message: string) => { startFailure = message; };
  document.body.append(editor);
  return editor;
}

function query(editor: PromptEditor, selector: string): Element | null {
  return editor.shadowRoot?.querySelector(selector) ?? null;
}

function clickButton(editor: PromptEditor, selector: string): void {
  const button = editor.shadowRoot?.querySelector<HTMLButtonElement>(selector);
  if (button === null || button === undefined) throw new Error(`Expected button ${selector} to be rendered`);
  button.click();
}

const settle = async (editor: PromptEditor) => {
  await editor.updateComplete;
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  await editor.updateComplete;
};

describe("PromptEditor voice dictation", () => {
  let fake: FakeDictation;

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
    fake = newFake();
  });

  afterEach(() => {
    const editor = document.body.querySelector<PromptEditor>("prompt-editor");
    if (editor !== null) {
      editor.disconnectedCallback();
      editor.remove();
    }
    document.body.replaceChildren();
    Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
    clearStagedAttachments("local:session-a");
  });

  it("places the mic button in the editor and the attach button left of send", async () => {
    const editor = createEditor(fake);
    await editor.updateComplete;

    const mic = query(editor, ".editor-mic");
    expect(mic).not.toBeNull();
    expect(mic?.getAttribute("aria-label")).toBe("Start voice dictation");
    // The mic sits inside the editor wrap (the old attach slot), attach does not.
    expect(mic?.closest(".editor-wrap")).not.toBeNull();

    const actions = query(editor, ".actions");
    expect(actions).not.toBeNull();
    const classNames = Array.from(actions?.querySelectorAll("button") ?? []).map((button) => button.className);
    const attachIndex = classNames.findIndex((className) => className.includes("editor-attach"));
    const sendIndex = classNames.findIndex((className) => className.includes("send-button"));
    expect(attachIndex).toBeGreaterThanOrEqual(0);
    expect(sendIndex).toBe(attachIndex + 1);
    // Attach no longer floats inside the editor wrap.
    expect(query(editor, ".editor-wrap .editor-attach")).toBeNull();
  });

  it("shows send and cancel buttons while recording and streams partials into the draft", async () => {
    const editor = createEditor(fake);
    await editor.updateComplete;

    clickButton(editor, ".editor-mic");
    await settle(editor);

    expect(query(editor, ".editor-mic.speech-send")).not.toBeNull();
    expect(query(editor, ".editor-cancel")).not.toBeNull();
    expect(query(editor, ".voice-hint-listening")).not.toBeNull();

    fake.emitPartial("hello world");
    await settle(editor);
    expect(Reflect.get(editor, "draft")).toContain("hello world");

    // Partial replacement: a second partial replaces, not appends.
    fake.emitPartial("hello there");
    await settle(editor);
    expect(Reflect.get(editor, "draft")).toBe("hello there");
  });

  it("send on the green button finishes, inserts the final text, and sends", async () => {
    const editor = createEditor(fake);
    await editor.updateComplete;
    let sent: { text: string } | undefined;
    editor.onSend = (text) => {
      sent = { text };
      return undefined;
    };

    clickButton(editor, ".editor-mic");
    await settle(editor);
    fake.emitPartial("partial words");
    await settle(editor);

    clickButton(editor, ".editor-mic.speech-send");
    await settle(editor);
    await settle(editor);

    expect(fake.finished).toBe(1);
    expect(sent?.text).toBe("final words");
    expect(Reflect.get(editor, "draft")).toBe("");
    expect(query(editor, ".editor-mic.speech-send")).toBeNull();
  });

  it("cancel discards the dictated region and keeps the prior draft", async () => {
    const editor = createEditor(fake);
    await editor.updateComplete;
    editor.replaceText("existing note ");
    await editor.updateComplete;

    clickButton(editor, ".editor-mic");
    await settle(editor);
    fake.emitPartial("transcribed stuff");
    await settle(editor);

    clickButton(editor, ".editor-cancel");
    await settle(editor);

    expect(fake.cancelled).toBe(1);
    expect(Reflect.get(editor, "draft")).toBe("existing note ");
    expect(query(editor, ".editor-cancel")).toBeNull();
  });

  it("surfaces a start failure as a visible error instead of recording state", async () => {
    const editor = createEditor(fake);
    await editor.updateComplete;
    fake.failStart("Microphone access was denied.");

    clickButton(editor, ".editor-mic");
    await settle(editor);
    await settle(editor);

    expect(query(editor, ".voice-hint-error")).not.toBeNull();
    expect(query(editor, ".editor-mic.speech-send")).toBeNull();
  });
});

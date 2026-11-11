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
  failFinish: (message: string) => void;
  finished: number;
  cancelled: number;
  committed: string;
  finishError?: string;
  controller: DictationController;
}

function newFake(): FakeDictation {
  const fake: FakeDictation = {
    emitPartial: () => { /* wired by createEditor */ },
    failStart: () => { /* wired by createEditor */ },
    failFinish: () => { /* wired by createEditor */ },
    finished: 0,
    cancelled: 0,
    committed: "",
    controller: {
      finish: () => {
        fake.finished += 1;
        if (fake.finishError !== undefined) return Promise.reject(new Error(fake.finishError));
        return Promise.resolve("final words");
      },
      committedText: () => fake.committed,
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
  fake.emitPartial = (text: string) => { fake.committed = text; partialSink?.(text); };
  fake.failStart = (message: string) => { startFailure = message; };
  fake.failFinish = (message: string) => { fake.finishError = message; };
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

  it("delivers to the origin chat when the user switches sessions mid-dictation", async () => {
    const editor = createEditor(fake);
    await editor.updateComplete;
    const sent: { text: string; target?: { machineId: string; sessionId: string; cwd: string } | undefined }[] = [];
    editor.onSend = (text, _behavior, _attachments, _delivery, _folder, target) => {
      sent.push({ text, target });
      return undefined;
    };

    clickButton(editor, ".editor-mic");
    await settle(editor);
    fake.emitPartial("hello");
    await settle(editor);

    editor.sessionId = "session-b";
    await settle(editor);
    // Partials stop painting into the new chat's draft.
    fake.emitPartial("hello world");
    await settle(editor);
    expect(Reflect.get(editor, "draft")).toBe("");

    clickButton(editor, ".editor-mic.speech-send");
    await settle(editor);
    await settle(editor);

    expect(fake.finished).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("final words");
    expect(sent[0]?.target).toEqual({ machineId: "local", sessionId: "session-a", cwd: "" });
    // The stale partial draft for the origin session is cleared.
    expect(localStorage.getItem("pi-web:prompt-draft:local:session-a")).toBeNull();
  });

  it("delivers the committed transcript when finish fails after switching", async () => {
    const editor = createEditor(fake);
    await editor.updateComplete;
    const sent: { text: string }[] = [];
    editor.onSend = (text) => {
      sent.push({ text });
      return undefined;
    };

    clickButton(editor, ".editor-mic");
    await settle(editor);
    fake.emitPartial("partial words");
    await settle(editor);
    fake.failFinish("speech session expired");

    editor.sessionId = "session-b";
    await settle(editor);
    clickButton(editor, ".editor-mic.speech-send");
    await settle(editor);
    await settle(editor);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("partial words [voice dictation: end not transcribed]");
    expect(localStorage.getItem("pi-web:prompt-draft:local:session-a")).toBeNull();
  });

  it("cancel after switching restores the origin draft", async () => {
    const editor = createEditor(fake);
    await editor.updateComplete;
    editor.replaceText("existing note ");
    await editor.updateComplete;

    clickButton(editor, ".editor-mic");
    await settle(editor);
    fake.emitPartial("transcribed stuff");
    await settle(editor);

    editor.sessionId = "session-b";
    await settle(editor);
    clickButton(editor, ".editor-cancel");
    await settle(editor);

    expect(fake.cancelled).toBe(1);
    expect(localStorage.getItem("pi-web:prompt-draft:local:session-a")).toBe("existing note ");
    expect(Reflect.get(editor, "draft")).toBe("");
  });
});

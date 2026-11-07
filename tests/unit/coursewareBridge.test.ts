import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { designHashOfLyl, parseCoursewareMessage } from "@/lib/coursewareBridge";
import { COMMAND_SHORTCUTS } from "@/lib/commandKeywords";
import { comboFromKeyPress } from "@/lib/customShortcuts";
import { setSimpleModeLists, simpleModeHiddenToolOfKey, simpleModeKeepsMenuItem, simpleModeKeepsShape, simpleModeKeepsTool, SIMPLE_MODE_SHAPES, SIMPLE_MODE_TOOLS } from "@/lib/simpleMode";

const envelope = { source: "courseware-cad", version: 1 };

describe("CourseWare bridge messages", () => {
  it("accepts an init with a lesson key, limits and a starter file", () => {
    const starter = new ArrayBuffer(4);
    const parsed = parseCoursewareMessage({ ...envelope, type: "init", lessonKey: "s1:l1", title: "Keychain", tools: ["undo", 5, ""], shapes: "all", starterLyl: starter });
    expect(parsed).toEqual({ type: "init", lessonKey: "s1:l1", title: "Keychain", tools: ["undo"], shapes: "all", starterLyl: starter, submittedLyl: undefined });
  });

  it("refuses messages without the envelope, of another version, or of an unknown type", () => {
    expect(parseCoursewareMessage({ type: "init", lessonKey: "x" })).toBeNull();
    expect(parseCoursewareMessage({ ...envelope, version: 2, type: "init", lessonKey: "x" })).toBeNull();
    expect(parseCoursewareMessage({ source: "papermorph-lesson", version: 1, type: "init", lessonKey: "x" })).toBeNull();
    expect(parseCoursewareMessage({ ...envelope, type: "delete-everything" })).toBeNull();
    expect(parseCoursewareMessage(null)).toBeNull();
    expect(parseCoursewareMessage("init")).toBeNull();
  });

  it("needs a lesson key for init, bytes for load and an id for a submission request", () => {
    expect(parseCoursewareMessage({ ...envelope, type: "init" })).toBeNull();
    expect(parseCoursewareMessage({ ...envelope, type: "load", lyl: "not bytes" })).toBeNull();
    expect(parseCoursewareMessage({ ...envelope, type: "request-submission" })).toBeNull();
    expect(parseCoursewareMessage({ ...envelope, type: "request-submission", requestId: "r1", include3mf: "yes" }))
      .toEqual({ type: "request-submission", requestId: "r1", include3mf: false, checkPrint: false });
  });

  it("accepts a review with bytes and refuses one without", () => {
    const bytes = new ArrayBuffer(8);
    expect(parseCoursewareMessage({ ...envelope, type: "review", lyl: bytes, title: "Peer design" })).toEqual({ type: "review", lyl: bytes, title: "Peer design" });
    expect(parseCoursewareMessage({ ...envelope, type: "review" })).toBeNull();
  });

  it("caps the length of ids and the number of them", () => {
    const many = Array.from({ length: 500 }, (_, index) => `tool${index}`);
    const parsed = parseCoursewareMessage({ ...envelope, type: "limits", tools: [...many, "x".repeat(65)] });
    expect(parsed && parsed.type === "limits" && Array.isArray(parsed.tools) ? parsed.tools.length : 0).toBe(200);
  });
});

describe("lesson tool lists in the simple mode", () => {
  afterEach(() => setSimpleModeLists(null, null));

  it("keeps the defaults until a lesson sets its own lists", () => {
    expect(simpleModeKeepsTool("mirror")).toBe(SIMPLE_MODE_TOOLS.has("mirror"));
    expect(simpleModeKeepsShape("box")).toBe(SIMPLE_MODE_SHAPES.has("box"));
  });

  it("keeps exactly a lesson's lists, everything for \"all\", and the defaults again for null", () => {
    setSimpleModeLists(["undo"], ["cylinder"]);
    expect(simpleModeKeepsTool("undo")).toBe(true);
    expect(simpleModeKeepsTool("mirror")).toBe(false);
    expect(simpleModeKeepsShape("cylinder")).toBe(true);
    expect(simpleModeKeepsShape("box")).toBe(false);
    setSimpleModeLists("all", "all");
    expect(simpleModeKeepsTool("anything")).toBe(true);
    expect(simpleModeKeepsShape("anything")).toBe(true);
    setSimpleModeLists(null, null);
    expect(simpleModeKeepsShape("box")).toBe(SIMPLE_MODE_SHAPES.has("box"));
  });
});

describe("no way round a lesson's tool list", () => {
  afterEach(() => setSimpleModeLists(null, null));
  const press = (key: string, modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {}) =>
    comboFromKeyPress({ key, code: `Key${key.toUpperCase()}`, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers } as KeyboardEvent);

  it("blocks the built-in key of a hidden ribbon tool and lets the others through", () => {
    setSimpleModeLists(["undo", "redo", "group"], ["box"]);
    expect(simpleModeHiddenToolOfKey(press("m"), COMMAND_SHORTCUTS)).toBe("mirror");
    expect(simpleModeHiddenToolOfKey(press("b", { shiftKey: true }), COMMAND_SHORTCUTS)).toBe("chamfer");
    expect(simpleModeHiddenToolOfKey(press("b", { ctrlKey: true }), COMMAND_SHORTCUTS)).toBe("bundle");
    expect(simpleModeHiddenToolOfKey(press("g", { ctrlKey: true }), COMMAND_SHORTCUTS)).toBeNull();
    expect(simpleModeHiddenToolOfKey(press("z", { ctrlKey: true }), COMMAND_SHORTCUTS)).toBeNull();
    expect(simpleModeHiddenToolOfKey(null, COMMAND_SHORTCUTS)).toBeNull();
  });

  it("knows the key of every tool it guards", () => {
    for (const id of ["group", "bundle", "ungroup", "align", "mirror", "fillet", "chamfer", "drop"]) expect(COMMAND_SHORTCUTS[id]).toBeTruthy();
  });

  it("keeps the right-click menu's everyday entries and drops the tools the lesson hides", () => {
    setSimpleModeLists(["undo", "fillet"], ["box"]);
    expect(simpleModeKeepsMenuItem("copy")).toBe(true);
    expect(simpleModeKeepsMenuItem("hole")).toBe(true);
    expect(simpleModeKeepsMenuItem("hide")).toBe(true);
    expect(simpleModeKeepsMenuItem("fillet")).toBe(true);
    expect(simpleModeKeepsMenuItem("chamfer")).toBe(false);
    expect(simpleModeKeepsMenuItem("punch")).toBe(false);
    expect(simpleModeKeepsMenuItem("mirror")).toBe(false);
    expect(simpleModeKeepsMenuItem("drop")).toBe(false);
    expect(simpleModeKeepsMenuItem("carry")).toBe(false);
  });
});

describe("the design hash of a submission", () => {
  const lyl = (metadata: Record<string, unknown>, states: unknown, thumbnail?: Uint8Array) => zipSync({
    "project.json": strToU8(JSON.stringify({ schema: "layerling.project", metadata, assets: [{ path: "assets/a", sha256: "abc" }], states })),
    ...(thumbnail ? { "thumbnail.png": thumbnail } : {}),
  });

  it("ignores names and save times, so an unchanged design hashes the same", async () => {
    const states = { active: { roots: ["box-1"] } };
    const first = await designHashOfLyl(lyl({ projectName: "Keychain", modifiedAt: 1 }, states));
    const second = await designHashOfLyl(lyl({ projectName: "Renamed", modifiedAt: 2 }, states));
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the design changes, and returns the thumbnail", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const first = await designHashOfLyl(lyl({}, { active: { roots: ["box-1"] } }, png));
    const second = await designHashOfLyl(lyl({}, { active: { roots: ["box-1", "box-2"] } }));
    expect(first.hash).not.toBe(second.hash);
    expect(first.thumbnail).toEqual(png);
    expect(second.thumbnail).toBeNull();
  });
});

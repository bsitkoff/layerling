/**
 * CourseWare bridge: lets a CourseWare lesson page embed layerling in an iframe.
 * The protocol is in docs/courseware-bridge.md.
 *
 * It is only active when every one of these is true:
 * - the page was opened with `?embed=courseware`,
 * - it runs inside a frame,
 * - the parent's origin is in NEXT_PUBLIC_COURSEWARE_ORIGINS (set at build time).
 * Otherwise layerling behaves exactly as upstream.
 *
 * Messages in both directions carry an envelope:
 *   parent → editor  { source: "courseware-cad",   version: 1, type, ... }
 *   editor → parent  { source: "layerling-editor", version: 1, type, ... }
 * Incoming messages are accepted only from window.parent at an allowed origin,
 * and outgoing ones are posted only to that origin.
 */
import { strFromU8, unzipSync } from "fflate";
import type { LayerlingMcpCommand, LayerlingMcpCommandName } from "@/lib/layerlingMcpProtocol";

export const COURSEWARE_SOURCE_IN = "courseware-cad";
export const COURSEWARE_SOURCE_OUT = "layerling-editor";
export const COURSEWARE_BRIDGE_VERSION = 1;

const EMBED_PARAMETER = "embed";
const EMBED_VALUE = "courseware";
const EMBED_SESSION_KEY = "layerling.coursewareEmbed";
const LESSON_PROJECTS_KEY = "layerling.coursewareLessons";
const DEFAULT_ORIGINS = "https://cscourseware.org";

/** Where the source of this modified copy lives (AGPL-3.0 section 13). */
export const COURSEWARE_SOURCE_URL = process.env.NEXT_PUBLIC_SOURCE_URL || "https://github.com/bsitkoff/layerling";

export function allowedCoursewareOrigins(): string[] {
  const raw = process.env.NEXT_PUBLIC_COURSEWARE_ORIGINS || DEFAULT_ORIGINS;
  return raw.split(",").map((origin) => origin.trim().replace(/\/+$/, "")).filter(Boolean);
}

/** The origin of the page that frames us, when the browser tells us. Chrome has ancestorOrigins; the referrer is the fallback. */
function framingOrigin(): string | null {
  const ancestors = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (ancestors && ancestors.length > 0) return ancestors[0];
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
}

let embedOrigin: string | null | undefined;

/**
 * The parent origin when the bridge is active, otherwise null. Worked out once.
 * The editor later rewrites the address (dropping `?embed=`), so the answer is kept in sessionStorage for reloads of this frame.
 */
export function coursewareEmbedOrigin(): string | null {
  if (embedOrigin !== undefined) return embedOrigin;
  embedOrigin = null;
  if (typeof window === "undefined" || window.parent === window) return embedOrigin;
  let requested = false;
  try {
    requested = new URLSearchParams(window.location.search).get(EMBED_PARAMETER) === EMBED_VALUE
      || window.sessionStorage.getItem(EMBED_SESSION_KEY) === EMBED_VALUE;
  } catch {
    requested = new URLSearchParams(window.location.search).get(EMBED_PARAMETER) === EMBED_VALUE;
  }
  if (!requested) return embedOrigin;
  const origin = framingOrigin();
  if (!origin || !allowedCoursewareOrigins().includes(origin)) return embedOrigin;
  try {
    window.sessionStorage.setItem(EMBED_SESSION_KEY, EMBED_VALUE);
  } catch {
    // Fine: only a reload of the frame would need it.
  }
  embedOrigin = origin;
  return embedOrigin;
}

export function isCoursewareEmbed(): boolean {
  return coursewareEmbedOrigin() !== null;
}

/** Inline script for <head>: marks the page before it paints, so the CSS can hide the chrome without a flash. */
export const COURSEWARE_EMBED_BOOT_SCRIPT = `try{var u=new URL(location.href);if(window.parent!==window&&(u.searchParams.get(${JSON.stringify(EMBED_PARAMETER)})===${JSON.stringify(EMBED_VALUE)}||sessionStorage.getItem(${JSON.stringify(EMBED_SESSION_KEY)})===${JSON.stringify(EMBED_VALUE)})){document.documentElement.dataset.coursewareEmbed="on";document.documentElement.dataset.simpleMode="on"}}catch(e){}`;

// ── Messages ────────────────────────────────────────────────────────────────

export type CoursewareLimits = {
  /** Ribbon tool ids to keep, or "all". Missing means the simple-mode defaults. */
  tools?: string[] | "all";
  /** Shape library ids to keep, or "all". Missing means the simple-mode defaults. */
  shapes?: string[] | "all";
};

export type CoursewareInbound =
  | ({
    type: "init";
    /** Opaque key for this student + lesson. One design per key is kept in this browser. */
    lessonKey: string;
    /** Name for a new design, e.g. the lesson title. */
    title?: string;
    /** Lesson-wide starting file, used only when this browser has no design for the key yet. */
    starterLyl?: ArrayBuffer;
    /** The student's last submission. Preferred over starterLyl when there is no local design. */
    submittedLyl?: ArrayBuffer;
  } & CoursewareLimits)
  | ({ type: "limits" } & CoursewareLimits)
  | { type: "load"; lyl: ArrayBuffer; title?: string }
  /** Grading or peer review: open someone's submission as a throwaway copy. It never becomes a lesson's design, and the previous copy is deleted. */
  | { type: "review"; lyl: ArrayBuffer; title?: string }
  | { type: "request-submission"; requestId: string; include3mf?: boolean; checkPrint?: boolean };

export type CoursewareOpenedSource = "local" | "submission" | "starter" | "blank" | "loaded" | "review";

export type CoursewareOutbound =
  | { type: "ready" }
  | { type: "opened"; lessonKey: string; from: CoursewareOpenedSource }
  | {
    type: "submission";
    requestId: string;
    lyl: ArrayBuffer;
    thumbnailPng: ArrayBuffer | null;
    threeMf: ArrayBuffer | null;
    /** SHA-256 (hex) of the design itself, ignoring save times, so an unchanged design hashes the same. */
    designHash: string;
    objectCount: number;
    printCheck: unknown;
  }
  | { type: "submission-error"; requestId: string; code: "empty" | "busy" | "failed"; message: string }
  | { type: "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function idList(value: unknown): string[] | "all" | undefined {
  if (value === "all") return "all";
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 64).slice(0, 200);
}

function buffer(value: unknown): ArrayBuffer | undefined {
  if (value instanceof ArrayBuffer) return value;
  if (value instanceof Uint8Array) return value.slice().buffer;
  return undefined;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

/** Shape-checks one incoming message. Anything unknown or malformed is null. */
export function parseCoursewareMessage(data: unknown): CoursewareInbound | null {
  if (!isRecord(data) || data.source !== COURSEWARE_SOURCE_IN || data.version !== COURSEWARE_BRIDGE_VERSION) return null;
  const limits = { tools: idList(data.tools), shapes: idList(data.shapes) };
  switch (data.type) {
    case "init": {
      const lessonKey = text(data.lessonKey, 200);
      if (!lessonKey) return null;
      return { type: "init", lessonKey, title: text(data.title, 120), starterLyl: buffer(data.starterLyl), submittedLyl: buffer(data.submittedLyl), ...limits };
    }
    case "limits":
      return { type: "limits", ...limits };
    case "load": {
      const lyl = buffer(data.lyl);
      return lyl ? { type: "load", lyl, title: text(data.title, 120) } : null;
    }
    case "review": {
      const lyl = buffer(data.lyl);
      return lyl ? { type: "review", lyl, title: text(data.title, 120) } : null;
    }
    case "request-submission": {
      const requestId = text(data.requestId, 100);
      if (!requestId) return null;
      return { type: "request-submission", requestId, include3mf: data.include3mf === true, checkPrint: data.checkPrint === true };
    }
    default:
      return null;
  }
}

export function postToCourseware(message: CoursewareOutbound, transfer: Transferable[] = []) {
  const origin = coursewareEmbedOrigin();
  if (!origin) return;
  window.parent.postMessage({ source: COURSEWARE_SOURCE_OUT, version: COURSEWARE_BRIDGE_VERSION, ...message }, origin, transfer);
}

export function onCoursewareMessage(handler: (message: CoursewareInbound) => void): () => void {
  const origin = coursewareEmbedOrigin();
  if (!origin) return () => {};
  const listener = (event: MessageEvent) => {
    if (event.origin !== origin || event.source !== window.parent) return;
    const message = parseCoursewareMessage(event.data);
    if (message) handler(message);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

// ── One design per lesson key ───────────────────────────────────────────────

function readLessonProjects(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(LESSON_PROJECTS_KEY) || "{}");
    return isRecord(parsed) ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  } catch {
    return {};
  }
}

export function lessonProjectId(lessonKey: string): string | null {
  return readLessonProjects()[lessonKey] ?? null;
}

/** The lesson key under which the current review copy is remembered, so the next review can delete it. */
export const REVIEW_LESSON_KEY = "__review__";

export function rememberLessonProject(lessonKey: string, projectId: string) {
  try {
    window.localStorage.setItem(LESSON_PROJECTS_KEY, JSON.stringify({ ...readLessonProjects(), [lessonKey]: projectId }));
  } catch {
    // Without storage the design still opens; the next visit starts again from the submission or starter.
  }
}

// ── Submissions ─────────────────────────────────────────────────────────────

type CommandRunner = (command: LayerlingMcpCommand) => Promise<unknown>;
let commandRunner: CommandRunner | null = null;

/** The editor hands over the same command runner its MCP connection uses. */
export function registerCoursewareCommandRunner(runner: CommandRunner | null) {
  commandRunner = runner;
}

let commandCounter = 0;
async function runCommand(action: LayerlingMcpCommandName, params: Record<string, unknown> = {}): Promise<unknown> {
  if (!commandRunner) throw new Error("The editor is not open yet.");
  commandCounter += 1;
  return commandRunner({ id: `courseware-${Date.now()}-${commandCounter}`, action, params, createdAt: Date.now() });
}

function base64Bytes(value: unknown): Uint8Array {
  if (!isRecord(value) || typeof value.base64 !== "string") throw new Error("The editor returned no file.");
  const binary = atob(value.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hash of what was designed: the object graphs and the asset hashes, without names, ids of the save or timestamps. */
export async function designHashOfLyl(lyl: Uint8Array): Promise<{ hash: string; thumbnail: Uint8Array | null }> {
  const files = unzipSync(lyl, { filter: (file) => file.name === "project.json" || file.name === "thumbnail.png" });
  const projectFile = files["project.json"];
  if (!projectFile) throw new Error("The saved design has no project.json.");
  const project: unknown = JSON.parse(strFromU8(projectFile));
  const states = isRecord(project) ? project.states : null;
  const assets = isRecord(project) && Array.isArray(project.assets)
    ? project.assets.map((asset) => (isRecord(asset) ? asset.sha256 ?? null : null))
    : [];
  return { hash: await sha256Hex(JSON.stringify({ states, assets })), thumbnail: files["thumbnail.png"] ?? null };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : bytes.slice().buffer;
}

/** Packs the open design for CourseWare and posts it (or a submission-error) back. */
export async function answerSubmissionRequest(request: Extract<CoursewareInbound, { type: "request-submission" }>) {
  const { requestId } = request;
  try {
    const listed = await runCommand("list_objects");
    const objects = isRecord(listed) && Array.isArray(listed.objects) ? listed.objects : [];
    if (objects.length === 0) {
      postToCourseware({ type: "submission-error", requestId, code: "empty", message: "Your design is empty. Add something before you submit." });
      return;
    }
    // No undo history in a submission: smaller files, and grading only needs the result.
    const lyl = base64Bytes(await runCommand("save_project", { history: 0 }));
    const { hash, thumbnail } = await designHashOfLyl(lyl);
    const threeMf = request.include3mf ? base64Bytes(await runCommand("export_mesh", { format: "3mf" })) : null;
    let printCheck: unknown = null;
    if (request.checkPrint) {
      const ids = objects.map((object) => (isRecord(object) ? object.id : null)).filter((id): id is string => typeof id === "string");
      printCheck = await runCommand("check_print", { ids }).catch((error: unknown) => ({ error: errorText(error) }));
    }
    const lylBuffer = ownBuffer(lyl);
    const thumbnailBuffer = thumbnail ? ownBuffer(thumbnail) : null;
    const threeMfBuffer = threeMf ? ownBuffer(threeMf) : null;
    postToCourseware(
      { type: "submission", requestId, lyl: lylBuffer, thumbnailPng: thumbnailBuffer, threeMf: threeMfBuffer, designHash: hash, objectCount: objects.length, printCheck },
      [lylBuffer, ...(thumbnailBuffer ? [thumbnailBuffer] : []), ...(threeMfBuffer ? [threeMfBuffer] : [])],
    );
  } catch (error) {
    const message = errorText(error);
    const busy = /finish|history view|not open/i.test(message);
    postToCourseware({ type: "submission-error", requestId, code: busy ? "busy" : "failed", message });
  }
}

"use client";

import { useEffect, useRef, useState } from "react";
import {
  answerSubmissionRequest,
  isCoursewareEmbed,
  lessonProjectId,
  onCoursewareMessage,
  postToCourseware,
  rememberLessonProject,
  REVIEW_LESSON_KEY,
  type CoursewareOpenedSource,
} from "@/lib/coursewareBridge";
import { lockSimpleModeForEmbed, setSimpleModeLists } from "@/lib/simpleMode";

type Options = {
  /** The start page has read the stored designs. */
  mounted: boolean;
  activeProjectId: string | null;
  projectExists: (projectId: string) => boolean;
  openProject: (projectId: string) => void;
  openLylBytes: (bytes: ArrayBuffer, fileName: string) => Promise<{ ok: boolean; message?: string } | void>;
  createBlank: (name?: string) => void;
  /** Deletes designs of this browser; used only for review copies. */
  deleteProjects: (projectIds: string[]) => void;
};

/**
 * The start page's half of the CourseWare bridge (lib/coursewareBridge.ts). It keeps one design per lesson key in this
 * browser. If there is none yet, it opens the student's last submission, else the lesson's starter, else an empty design.
 * Returns whether the page is embedded, so the start page can stay hidden.
 */
export function useCoursewareEmbed(options: Options): boolean {
  const [embedded, setEmbedded] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const lessonKeyRef = useRef<string | null>(null);
  const pendingRef = useRef<{ lessonKey: string; from: CoursewareOpenedSource } | null>(null);

  useEffect(() => {
    if (isCoursewareEmbed()) {
      setEmbedded(true);
      lockSimpleModeForEmbed();
    }
  }, []);

  useEffect(() => {
    if (!embedded || !options.mounted) return;
    const openBytes = (lessonKey: string, from: CoursewareOpenedSource, bytes: ArrayBuffer, name: string) => {
      pendingRef.current = { lessonKey, from };
      void optionsRef.current.openLylBytes(bytes, `${name}.lyl`).then((result) => {
        if (result && !result.ok) {
          pendingRef.current = null;
          postToCourseware({ type: "error", message: result.message ?? "Could not open the design." });
        }
      });
    };
    const unsubscribe = onCoursewareMessage((message) => {
      const current = optionsRef.current;
      if (message.type === "init" || message.type === "limits") {
        setSimpleModeLists(message.tools ?? null, message.shapes ?? null);
      }
      if (message.type === "init") {
        const { lessonKey } = message;
        const name = message.title || "My design";
        // CourseWare may send init again (e.g. after a reconnect); the design that is open stays open.
        if (lessonKeyRef.current === lessonKey && (current.activeProjectId || pendingRef.current)) return;
        lessonKeyRef.current = lessonKey;
        const known = lessonProjectId(lessonKey);
        if (known && current.projectExists(known)) {
          current.openProject(known);
          postToCourseware({ type: "opened", lessonKey, from: "local" });
        } else if (message.submittedLyl) {
          openBytes(lessonKey, "submission", message.submittedLyl, name);
        } else if (message.starterLyl) {
          openBytes(lessonKey, "starter", message.starterLyl, name);
        } else {
          pendingRef.current = { lessonKey, from: "blank" };
          current.createBlank(name);
        }
      } else if (message.type === "load") {
        if (!lessonKeyRef.current) return;
        openBytes(lessonKeyRef.current, "loaded", message.lyl, message.title || "My design");
      } else if (message.type === "review") {
        lessonKeyRef.current = null;
        openBytes(REVIEW_LESSON_KEY, "review", message.lyl, message.title || "Review copy");
      } else if (message.type === "request-submission") {
        void answerSubmissionRequest(message);
      }
    });
    postToCourseware({ type: "ready" });
    return unsubscribe;
  }, [embedded, options.mounted]);

  // A design opened for a lesson becomes that lesson's design in this browser.
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || !options.activeProjectId) return;
    pendingRef.current = null;
    // The review copy before this one is no longer needed (it is not open, so deleting it is safe).
    const previousReview = pending.from === "review" ? lessonProjectId(REVIEW_LESSON_KEY) : null;
    if (previousReview && previousReview !== options.activeProjectId && optionsRef.current.projectExists(previousReview)) {
      optionsRef.current.deleteProjects([previousReview]);
    }
    rememberLessonProject(pending.lessonKey, options.activeProjectId);
    postToCourseware({ type: "opened", lessonKey: pending.lessonKey, from: pending.from });
  }, [options.activeProjectId]);

  return embedded;
}

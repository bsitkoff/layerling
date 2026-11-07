"use client";

import { useSyncExternalStore } from "react";
import { getSimpleMode, getSimpleModeListsVersion, subscribeToSimpleMode, subscribeToSimpleModeLists } from "@/lib/simpleMode";

export function useSimpleMode(): boolean {
  return useSyncExternalStore(subscribeToSimpleMode, getSimpleMode, () => false);
}

/** Changes whenever an embedding page swaps the simple mode's tool or shape lists. */
export function useSimpleModeListsVersion(): number {
  return useSyncExternalStore(subscribeToSimpleModeLists, getSimpleModeListsVersion, () => 0);
}

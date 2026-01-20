import { flushSync } from "react-dom";

interface ViewTransition {
  finished: Promise<void>;
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition(): void;
}

interface DocumentWithViewTransition extends Document {
  startViewTransition?: (
    callback?: () => Promise<void> | void
  ) => ViewTransition;
}

export const safeStartViewTransition = (callback: () => void) => {
  const doc = document as DocumentWithViewTransition;
  if (!doc.startViewTransition || document.visibilityState !== "visible") {
    callback();
    return;
  }

  return doc.startViewTransition(() => {
    flushSync(callback);
  });
};

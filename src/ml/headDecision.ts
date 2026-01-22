
import type { HeadStatus } from "./headClassifier";
import type { GazeStatus } from "./gazeDetector";

const FPS = 30;
const REQUIRED_SECONDS = 2;

const HEAD_THRESHOLD = FPS * REQUIRED_SECONDS;
const GAZE_THRESHOLD = FPS * REQUIRED_SECONDS;

let headCounter = 0;
let gazeCounter = 0;
let lastAlertTime = 0;

export function decideMalpractice(head: HeadStatus, gaze: GazeStatus) {
  // ---------- HEAD ----------
  if (head !== "straight") {
    headCounter++;
  } else {
    headCounter = Math.max(0, headCounter - 2);
  }

  // ---------- GAZE ----------
  if (gaze !== "center") {
    gazeCounter++;
  } else {
    gazeCounter = Math.max(0, gazeCounter - 2);
  }

  const now = Date.now();

  // Trigger if **either** sustained head OR sustained gaze
  const headViolation = headCounter >= HEAD_THRESHOLD;
  const gazeViolation = gazeCounter >= GAZE_THRESHOLD;

  if ((headViolation || gazeViolation) && now - lastAlertTime > 2000) {
    lastAlertTime = now;
    return {
      headViolation,
      gazeViolation
    };
  }

  return null;
}

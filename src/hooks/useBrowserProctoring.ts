import { useEffect, useRef } from "react";

export type BrowserViolation = "fullscreen-exit" | "tab-switch";

interface BrowserProctoringProps {
  enabled: boolean;
  fullScreenRequired: boolean;
  onViolation: (reason: BrowserViolation) => void;
}

export function useBrowserProctoring({
  enabled,
  fullScreenRequired,
  onViolation
}: BrowserProctoringProps) {
  const triggeredRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const triggerOnce = (reason: BrowserViolation) => {
      if (triggeredRef.current) return;
      triggeredRef.current = true;
      onViolation(reason);
    };

    /* ---------- TAB SWITCH ---------- */
    const onVisibilityChange = () => {
      if (document.hidden) {
        triggerOnce("tab-switch");
      }
    };

    const onWindowBlur = () => {
      triggerOnce("tab-switch");
    };

    /* ---------- FULLSCREEN EXIT ---------- */
    const onFullscreenChange = () => {
      if (fullScreenRequired && !document.fullscreenElement) {
        triggerOnce("fullscreen-exit");
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      triggeredRef.current = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [enabled, fullScreenRequired, onViolation]);
}
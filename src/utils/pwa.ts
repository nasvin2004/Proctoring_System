export function isIOSStandalonePWA(): boolean {
  return (
    // iOS Safari "Add to Home Screen"
    (window.navigator as any).standalone === true ||

    // Modern PWA check
    window.matchMedia("(display-mode: standalone)").matches
  );
}

import { useRef, useState, useEffect } from "react";
import { loadFaceLandmarker } from "../ml/faceLandmarker";
import { extractHeadPose } from "../ml/headPose";
import { classifyHeadPose } from "../ml/headClassifier";
import { detectGaze } from "../ml/gazeDetector";
import { decideMalpractice } from "../ml/headDecision";
import { loadObjectModel, detectObjects } from "../ml/objectDetector";
import { useBrowserProctoring } from "../hooks/useBrowserProctoring";

type LogItem = {
  time: string;
  type: "error" | "warning" | "info";
  message: string;
};

export default function ProctorCamera() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<any>(null);
  const runningRef = useRef(false);

  /* ---------------- STATE ---------------- */
  const [isRunning, setIsRunning] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingPercent, setLoadingPercent] = useState(0);
  const [fullscreenBlocked, setFullscreenBlocked] = useState(false);
  const [logs, setLogs] = useState<LogItem[]>([]);

  /* ---------------- LOG HELPER ---------------- */
  const addLog = (type: LogItem["type"], message: string) => {
    setLogs((prev) => [
      ...prev,
      { time: new Date().toLocaleTimeString(), type, message },
    ]);
  };

  /* ---------------- BROWSER PROCTORING ---------------- */
  useBrowserProctoring({
    enabled: isRunning,
    fullScreenRequired: true,
    onViolation: (reason) => {
      if (reason === "fullscreen-exit") {
        setFullscreenBlocked(true);
        addLog("error", "Fullscreen exited. Please re-enter fullscreen.");
      }
      if (reason === "tab-switch") {
        addLog("error", "Tab switch or window focus lost");
      }
    },
  });

  /* ---------------- VIDEO READY HELPER ---------------- */
  const waitForVideoReady = (video: HTMLVideoElement) =>
    new Promise<void>((resolve) => {
      if (video.videoWidth > 0 && video.videoHeight > 0) return resolve();
      const handler = () => {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          video.removeEventListener("loadeddata", handler);
          resolve();
        }
      };
      video.addEventListener("loadeddata", handler);
    });

  /* ---------------- CAMERA ---------------- */
  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  /* ---------------- FULLSCREEN ---------------- */
  const enterFullscreen = async () => {
    if (containerRef.current && !document.fullscreenElement) {
      await containerRef.current.requestFullscreen();
    }
  };

  const exitFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
  };

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && isRunning) setFullscreenBlocked(true);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [isRunning]);

  /* ---------------- PROCTORING ---------------- */
  const startProctoring = async () => {
    if (runningRef.current || isLoading) return;

    setLogs([]);
    setIsLoading(true);
    setLoadingPercent(0);
    addLog("info", "Initializing camera & models…");

    try {
      // 1️⃣ Camera
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      streamRef.current = stream;
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await waitForVideoReady(videoRef.current);

      // 2️⃣ Load models with progress
      setLoadingPercent(30);
      landmarkerRef.current = await loadFaceLandmarker();

      setLoadingPercent(70);
      await loadObjectModel();

      setLoadingPercent(100);
      setIsLoading(false);

      // 3️⃣ Enter fullscreen after models loaded
      await enterFullscreen();
      setFullscreenBlocked(false);

      // 4️⃣ Start loop
      runningRef.current = true;
      setIsRunning(true);
      addLog("info", "Proctoring started");

      let faceLostAlerted = false;
      let objectFrame = 0;

      const loop = async () => {
        if (!runningRef.current || !videoRef.current) return;
        const video = videoRef.current;

        if (video.videoWidth === 0 || video.videoHeight === 0) {
          requestAnimationFrame(loop);
          return;
        }

        const now = performance.now();
        const result = landmarkerRef.current.detectForVideo(video, now);
        const faceCount = result.faceLandmarks.length;

        if (faceCount === 0) {
          if (!faceLostAlerted) {
            addLog("error", "Face not detected");
            faceLostAlerted = true;
          }
          requestAnimationFrame(loop);
          return;
        }

        faceLostAlerted = false;

        if (faceCount > 1)
          addLog("warning", `Multiple persons detected (${faceCount})`);

        const landmarks = result.faceLandmarks[0];
        const matrix = result.facialTransformationMatrixes[0].data;

        const { yaw, pitch, roll } = extractHeadPose(matrix);
        const head = classifyHeadPose(yaw, pitch, roll);
        const gaze = detectGaze(landmarks);

        const alert = decideMalpractice(head, gaze);
        if (alert?.headViolation) addLog("warning", "Head deviation sustained");
        if (alert?.gazeViolation) addLog("warning", "Gaze deviation sustained");

        if (objectFrame++ % 60 === 0) {
          const objects = await detectObjects(video);
          objects.forEach((obj) =>
            addLog("error", `Prohibited object detected: ${obj}`)
          );
        }

        requestAnimationFrame(loop);
      };

      loop();
    } catch (err) {
      console.error(err);
      setIsLoading(false);
      addLog("error", "Failed to start proctoring");
      stopProctoring();
    }
  };

  const stopProctoring = async () => {
    runningRef.current = false;
    setIsRunning(false);
    setIsLoading(false);
    setFullscreenBlocked(false);
    stopCamera();
    addLog("info", "Proctoring stopped");
    await exitFullscreen();
  };

  const reEnterFullscreen = async () => {
    try {
      await enterFullscreen();
      setFullscreenBlocked(false);
      addLog("info", "Fullscreen re-entered");
    } catch {
      addLog("warning", "Fullscreen denied");
    }
  };

  /* ---------------- UI ---------------- */
  return (
    <div
      ref={containerRef}
      style={{
        height: "100vh",
        width: "100vw",
        background: "#020617",
        color: "#fff",
        overflowY: "auto", // ✅ scrollable in fullscreen
        padding: 16,
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <h2 style={{ textAlign: "center", fontWeight: 600 }}>🧠 AI Proctoring System</h2>

        {/* CAMERA */}
        <div style={{ background: "#020617", padding: 12, borderRadius: 12 }}>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            style={{ width: "100%", aspectRatio: "16 / 9", borderRadius: 10, background: "#000" }}
          />

          {/* LOADING */}
          {isLoading && (
            <div style={{ marginTop: 10 }}>
              <strong>Loading models… {loadingPercent}%</strong>
              <div style={{ height: 6, background: "#334155", borderRadius: 4, overflow: "hidden", marginTop: 4 }}>
                <div style={{ width: `${loadingPercent}%`, height: "100%", background: "#22c55e", transition: "width 0.3s" }} />
              </div>
            </div>
          )}

          {/* CONTROLS */}
          <div style={{ marginTop: 12, display: "flex", gap: 12, justifyContent: "center" }}>
            <button
              onClick={startProctoring}
              disabled={isRunning || isLoading || fullscreenBlocked}
              style={{
                padding: "10px 18px",
                background: isRunning || isLoading ? "#14532d" : "#22c55e",
                borderRadius: 8,
                fontWeight: 600,
                minWidth: 120,
              }}
            >
              ▶ Start
            </button>

            <button
              onClick={stopProctoring}
              disabled={!isRunning}
              style={{
                padding: "10px 18px",
                background: !isRunning ? "#7f1d1d" : "#ef4444",
                borderRadius: 8,
                fontWeight: 600,
                minWidth: 120,
                color: "#fff",
              }}
            >
              ⏹ Stop
            </button>
          </div>
        </div>

        {/* ALERTS */}
        <div style={{ background: "#020617", borderRadius: 12, padding: 12, flex: 1, minHeight: 200 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>⚠️ Proctoring Alerts</div>
          <div style={{ height: "100%", overflowY: "auto", paddingRight: 6 }}>
            {logs.length === 0 && <div style={{ color: "#94a3b8" }}>No violations detected</div>}
            {logs.map((log, i) => (
              <div
                key={i}
                style={{
                  marginTop: 6,
                  padding: "6px 8px",
                  borderRadius: 6,
                  borderLeft: log.type === "error" ? "4px solid #ef4444" : log.type === "warning" ? "4px solid #facc15" : "4px solid #38bdf8",
                  fontSize: 13,
                }}
              >
                <strong>[{log.time}]</strong> {log.message}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* FULLSCREEN BLOCK */}
      {fullscreenBlocked && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            flexDirection: "column",
            textAlign: "center",
            padding: 16,
          }}
        >
          <h2 style={{ color: "#f87171", marginBottom: 12 }}>⚠ Fullscreen Required</h2>
          <p style={{ color: "#cbd5f5", marginBottom: 16 }}>
            You exited fullscreen. Please re-enter fullscreen to continue the exam.
          </p>
          <button
            onClick={reEnterFullscreen}
            style={{
              padding: "10px 20px",
              background: "#22c55e",
              color: "#000",
              borderRadius: 8,
              fontWeight: 600,
            }}
          >
            Re-enter Fullscreen
          </button>
        </div>
      )}
    </div>
  );
}

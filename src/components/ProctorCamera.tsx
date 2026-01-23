import { useRef, useState } from "react";
import { loadFaceLandmarker } from "../ml/faceLandmarker";
import { extractHeadPose } from "../ml/headPose";
import { classifyHeadPose } from "../ml/headClassifier";
import { detectGaze } from "../ml/gazeDetector";
import { decideMalpractice } from "../ml/headDecision";
import { loadObjectModel, detectObjects } from "../ml/objectDetector";


type LogItem = {
  time: string;
  type: "error" | "warning" | "info";
  message: string;
};

export default function ProctorCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const runningRef = useRef(false);

  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<LogItem[]>([]);

  const addLog = (type: LogItem["type"], message: string) => {
    setLogs(prev => [
      ...prev,
      {
        time: new Date().toLocaleTimeString(),
        type,
        message
      }
    ]);
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const startProctoring = async () => {
    if (runningRef.current) return;

    setLogs([]);
    setIsRunning(true);
    runningRef.current = true;

    addLog("info", "Proctoring started");

    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    streamRef.current = stream;
    if (videoRef.current) videoRef.current.srcObject = stream;

    const landmarker = await loadFaceLandmarker();
    await loadObjectModel();

    let faceLostAlerted = false;
    let objectFrame = 0;

    const loop = async () => {
      if (!runningRef.current || !videoRef.current) return;

      const now = performance.now();
      const result = landmarker.detectForVideo(videoRef.current, now);
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

      if (faceCount > 1) {
        addLog("warning", `Multiple persons detected (${faceCount})`);
      }

      const landmarks = result.faceLandmarks[0];
      const matrix = result.facialTransformationMatrixes[0].data;

      const { yaw, pitch, roll } = extractHeadPose(matrix);
      const head = classifyHeadPose(yaw, pitch, roll);
      const gaze = detectGaze(landmarks);

      const alert = decideMalpractice(head, gaze);

      if (alert?.headViolation) {
        addLog("warning", "Head deviation sustained");
      }

      if (alert?.gazeViolation) {
        addLog("warning", "Gaze deviation sustained");
      }

      if (objectFrame++ % 60 === 0) {
        const objects = await detectObjects(videoRef.current);
        objects.forEach(obj =>
          addLog("error", `Prohibited object detected: ${obj}`)
        );
      }

      requestAnimationFrame(loop);
    };

    loop();
  };

  const stopProctoring = () => {
    runningRef.current = false;
    setIsRunning(false);
    stopCamera();
    addLog("info", "Proctoring stopped");
  };

 return (
  <div
    style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #020617, #020617)",
      padding: 16,
      color: "#fff"
    }}
  >
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        maxWidth: 1100,
        margin: "0 auto"
      }}
    >
      {/* 🔝 Header */}
      <h2 style={{ textAlign: "center", fontSize: 20, fontWeight: 600 }}>
        🧠 AI Proctoring System
      </h2>

      {/* 📦 Main layout */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16
        }}
      >
        {/* 🎥 Camera Card */}
        <div
          style={{
            background: "#020617",
            borderRadius: 12,
            padding: 12,
            boxShadow: "0 10px 25px rgba(0,0,0,0.4)"
          }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{
              width: "100%",
              aspectRatio: "16 / 9",
              borderRadius: 10,
              background: "#000"
            }}
          />

          {/* 🎛 Controls */}
          <div
            style={{
              marginTop: 12,
              display: "flex",
              gap: 12,
              justifyContent: "center"
            }}
          >
            <button
              onClick={startProctoring}
              disabled={isRunning}
              style={{
                padding: "10px 18px",
                background: isRunning ? "#14532d" : "#22c55e",
                color: "#000",
                borderRadius: 8,
                fontWeight: 600,
                minWidth: 120
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
                color: "#fff",
                borderRadius: 8,
                fontWeight: 600,
                minWidth: 120
              }}
            >
              ⏹ Stop
            </button>
          </div>
        </div>

        {/* 🚨 Alerts Card */}
        <div
          style={{
            background: "#020617",
            borderRadius: 12,
            padding: 12,
            boxShadow: "0 10px 25px rgba(0,0,0,0.4)"
          }}
        >
          <div
            style={{
              fontWeight: 600,
              marginBottom: 8,
              fontSize: 15
            }}
          >
            ⚠️ Proctoring Alerts
          </div>

          <div
            style={{
              maxHeight: 300,
              overflowY: "auto",
              paddingRight: 4
            }}
          >
            {logs.length === 0 && (
              <div style={{ color: "#94a3b8" }}>
                No violations detected
              </div>
            )}

            {logs.map((log, idx) => (
              <div
                key={idx}
                style={{
                  marginTop: 6,
                  padding: "6px 8px",
                  borderRadius: 6,
                  background: "#020617",
                  borderLeft:
                    log.type === "error"
                      ? "4px solid #ef4444"
                      : log.type === "warning"
                      ? "4px solid #facc15"
                      : "4px solid #38bdf8",
                  color:
                    log.type === "error"
                      ? "#fca5a5"
                      : log.type === "warning"
                      ? "#fde68a"
                      : "#7dd3fc",
                  fontSize: 13
                }}
              >
                <strong>[{log.time}]</strong> {log.message}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>

    {/* 📐 Responsive tweak */}
    <style>
      {`
        @media (min-width: 768px) {
          .main-layout {
            flex-direction: row;
          }
        }
      `}
    </style>
  </div>
);

}

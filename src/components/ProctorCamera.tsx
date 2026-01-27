import { useRef, useState } from "react";
import { loadFaceLandmarker } from "../ml/faceLandmarker";
import { extractHeadPose } from "../ml/headPose";
import { classifyHeadPose } from "../ml/headClassifier";
import { detectGaze } from "../ml/gazeDetector";
import { decideMalpractice } from "../ml/headDecision";
import { loadObjectModel, detectObjects } from "../ml/objectDetector";
import { useBrowserProctoring } from "../hooks/useBrowserProctoring";

/* ---------------- TYPES ---------------- */
type LogItem = {
  time: string;
  type: "error" | "warning" | "info";
  message: string;
};

type ScreenshotItem = {
  time: string;
  url: string;
};

type CameraShotItem = {
  time: string;
  reason: string;
  url: string;
};

export default function ProctorCamera() {
  /* ---------------- REFS ---------------- */
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const runningRef = useRef(false);
  const tabSwitchGraceUntilRef = useRef<number>(0);

  /* ⏱ RANDOM CAMERA SHOT INTERVAL */
  const randomShotIntervalRef = useRef<number | null>(null);

  /* ⏱ CAMERA SCREENSHOT COOLDOWN */
  const lastCameraShotByReasonRef = useRef<Record<string, number>>({});
  const CAMERA_SHOT_COOLDOWN_MS = 60_000; // 1 minute

  /* ⏱ RANDOM CAMERA SHOT COOLDOWN */
  const lastRandomShotTimeRef = useRef<number>(0);
  const RANDOM_SHOT_COOLDOWN_MS = 10_000; // 10 seconds

  /* ---------------- STATE ---------------- */
  const [isRunning, setIsRunning] = useState(false);
  const [fullscreenBlocked, setFullscreenBlocked] = useState(false);
  const [sessionVideoUrl, setSessionVideoUrl] = useState<string | null>(null);
  const [screenshots, setScreenshots] = useState<ScreenshotItem[]>([]);
  const [cameraShots, setCameraShots] = useState<CameraShotItem[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const isMobile =
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  tabSwitchGraceUntilRef.current = Date.now() + 1000; // ⏱ 1 seconds grace

  /* ---------------- LOGGING ---------------- */
  const addLog = (type: LogItem["type"], message: string) => {
    setLogs((prev) => [
      ...prev,
      { time: new Date().toLocaleTimeString(), type, message },
    ]);
  };

  /* ---------------- RANDOM CAMERA SHOT (SEPARATE COOLDOWN) ---------------- */
  const captureRandomShot = () => {
    if (!videoRef.current || !videoRef.current.videoWidth) return;

    const now = Date.now();

    // ⛔ 30s cooldown for RANDOM shots only
    if (now - lastRandomShotTimeRef.current < RANDOM_SHOT_COOLDOWN_MS) {
      return;
    }

    lastRandomShotTimeRef.current = now;

    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(
      (blob) => {
        if (!blob) return;

        const url = URL.createObjectURL(blob);

        setCameraShots((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            reason: "Random camera snapshot",
            url,
          },
        ]);

        addLog("info", "Random camera snapshot captured");
      },
      "image/jpeg",
      0.7,
    );
  };

  /* ---------------- CAMERA FRAME CAPTURE (PER-REASON COOLDOWN) ---------------- */
  const captureCameraFrame = (reason: string) => {
    if (!videoRef.current || !videoRef.current.videoWidth) return;

    const now = Date.now();
    const lastShotTime = lastCameraShotByReasonRef.current[reason] ?? 0;

    // ⛔ Per-reason cooldown check
    if (now - lastShotTime < CAMERA_SHOT_COOLDOWN_MS) {
      return;
    }

    // ✅ Update last shot time for this reason
    lastCameraShotByReasonRef.current[reason] = now;

    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(
      (blob) => {
        if (!blob) return;

        const url = URL.createObjectURL(blob);
        setCameraShots((prev) => [
          ...prev,
          {
            time: new Date().toLocaleTimeString(),
            reason,
            url,
          },
        ]);

        addLog("warning", `Camera shot captured: ${reason}`);
      },
      "image/jpeg",
      0.7,
    );
  };

  /* ---------------- SCREENSHOT CAPTURE (TAB SWITCH) ---------------- */
  const captureScreenshot = async () => {
    if (!screenStreamRef.current) return;

    try {
      const video = document.createElement("video");
      video.srcObject = screenStreamRef.current;
      video.muted = true;
      video.playsInline = true;

      await video.play();

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res, "image/png"),
      );

      video.pause();
      video.srcObject = null;

      if (!blob) return;

      const url = URL.createObjectURL(blob);

      setScreenshots((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString(),
          url,
        },
      ]);

      addLog("warning", "Screenshot captured on tab switch");
    } catch {
      addLog("warning", "Failed to capture screenshot");
    }
  };

  /* ---------------- BROWSER PROCTORING ---------------- */
  useBrowserProctoring({
    enabled: isRunning,
    fullScreenRequired: true,
    onViolation: (reason) => {
      if (reason === "fullscreen-exit") {
        addLog("error", "Fullscreen exited during exam");
        setFullscreenBlocked(true);
      }

      if (reason === "tab-switch") {
        if (Date.now() < tabSwitchGraceUntilRef.current) {
          return;
        }

        addLog("error", "Tab switch / window focus lost");
        setTimeout(() => {
          captureScreenshot();
        }, 1000);
      }
    },
  });

  /* ---------------- SCREEN SHARE (STRICT) ---------------- */
  // const requestScreenShare = async (): Promise<MediaStream | null> => {
  //   try {
  //     const stream = await navigator.mediaDevices.getDisplayMedia({
  //       video: { frameRate: 30 },
  //       audio: true,
  //     });

  //     const track = stream.getVideoTracks()[0];
  //     const settings = track.getSettings();

  //     if (settings.displaySurface !== "monitor") {
  //       stream.getTracks().forEach((t) => t.stop());
  //       addLog("error", "Violation: Entire screen not shared");
  //       return null;
  //     }

  //     screenStreamRef.current = stream;
  //     addLog("info", "Entire screen shared successfully");
  //     return stream;
  //   } catch {
  //     addLog("error", "Screen sharing permission denied");
  //     return null;
  //   }
  // };

  const requestScreenShare = async (): Promise<MediaStream | null> => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
      });

      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();

      // ✅ Log what user shared (no blocking)
      addLog("info", `Screen shared: ${settings.displaySurface ?? "unknown"}`);

      screenStreamRef.current = stream;
      return stream;
    } catch (err) {
      console.error("Screen share error:", err);
      addLog("error", "Screen sharing permission denied or cancelled");
      return null;
    }
  };

  /* ---------------- RECORDING ---------------- */
  const startRecording = (stream: MediaStream) => {
    recordedChunksRef.current = [];

    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm; codecs=vp9",
    });

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, {
        type: "video/webm",
      });

      const url = URL.createObjectURL(blob);
      setSessionVideoUrl(url);

      const a = document.createElement("a");
      a.click();

      addLog("info", "Session recording saved and downloaded");
    };

    recorder.start();
    recorderRef.current = recorder;
    addLog("info", "Session recording started");
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;

    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
  };

  /* ---------------- CAMERA ---------------- */
  const stopCamera = () => {
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    cameraStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  /* ---------------- FULLSCREEN ---------------- */
  const reEnterFullscreen = async () => {
    try {
      await document.documentElement.requestFullscreen();
      setFullscreenBlocked(false);
      addLog("info", "Fullscreen re-entered");
    } catch {
      addLog("warning", "Fullscreen request denied");
    }
  };

  /* ---------------- START PROCTORING ---------------- */
  const startProctoring = async () => {
    if (runningRef.current) return;

    setLogs([]);
    setScreenshots([]);
    setCameraShots([]);
    setSessionVideoUrl(null);
    setIsRunning(true);
    runningRef.current = true;

    addLog("info", "Proctoring started");

    // const screenStream = await requestScreenShare();
    // if (!screenStream) {
    //   setIsRunning(false);
    //   runningRef.current = false;
    //   addLog("warning", "Exam not started. Share entire screen.");
    //   return;
    // }

    if (isMobile) {
      addLog("warning", "Screen sharing not supported on mobile browsers");
    } else {
      const screenStream = await requestScreenShare();
      if (!screenStream) {
        setIsRunning(false);
        runningRef.current = false;
        addLog("warning", "Exam not started. Screen sharing required.");
        return;
      }
      startRecording(screenStream);
    }


    // startRecording(screenStream);

    const cameraStream = await navigator.mediaDevices.getUserMedia({
      video: true,
    });
    cameraStreamRef.current = cameraStream;
    if (videoRef.current) videoRef.current.srcObject = cameraStream;

    await document.documentElement.requestFullscreen().catch(() => {
      addLog("warning", "Fullscreen request failed initially");
    });

    addLog("info","Loading model....");

    const landmarker = await loadFaceLandmarker();
    await loadObjectModel();

    addLog("info", "Model Loaded")

    
    let faceLostAlerted = false;
    let objectFrame = 0;

    const loop = async () => {
      if (!runningRef.current || !videoRef.current) return;
      if (
        !videoRef.current ||
        videoRef.current.videoWidth === 0 ||
        videoRef.current.videoHeight === 0 ||
        videoRef.current.readyState < 2 // HAVE_CURRENT_DATA
      ) {
        requestAnimationFrame(loop);
        return;
      }

      const now = performance.now();
      const result = landmarker.detectForVideo(videoRef.current, now);
      const faceCount = result.faceLandmarks.length;

      if (faceCount === 0) {
        if (!faceLostAlerted) {
          addLog("error", "Face not detected");
          captureCameraFrame("Face not detected");
          faceLostAlerted = true;
        }
        requestAnimationFrame(loop);
        return;
      }

      faceLostAlerted = false;

      if (faceCount > 1) {
        addLog("warning", `Multiple persons detected (${faceCount})`);
        captureCameraFrame(`Multiple faces detected (${faceCount})`);
      }

      const landmarks = result.faceLandmarks[0];
      const matrix = result.facialTransformationMatrixes?.[0]?.data;

      if (matrix) {
        const { yaw, pitch, roll } = extractHeadPose(matrix);
        const head = classifyHeadPose(yaw, pitch, roll);
        const gaze = detectGaze(landmarks);
        const alert = decideMalpractice(head, gaze);

        if (alert?.headViolation) {
          addLog("warning", "Head deviation sustained");
          captureCameraFrame("Head deviation");
        }
        if (alert?.gazeViolation) {
          addLog("warning", "Gaze deviation sustained");
          captureCameraFrame("Gaze deviation");
        }
      }

      if (objectFrame++ % 60 === 0) {
        const objects = await detectObjects(videoRef.current);
        objects.forEach((obj) => {
          addLog("error", `Prohibited object detected: ${obj}`);
          captureCameraFrame(`Object detected: ${obj}`);
        });
      }

      requestAnimationFrame(loop);
    };

    // 🎲 Start random camera snapshots every 30 seconds
    randomShotIntervalRef.current = window.setInterval(() => {
      if (!runningRef.current) return;
      captureRandomShot();
    }, RANDOM_SHOT_COOLDOWN_MS);

    loop();
  };

  /* ---------------- STOP PROCTORING ---------------- */
  const stopProctoring = () => {
    // 🛑 Stop random snapshot interval
    if (randomShotIntervalRef.current) {
      clearInterval(randomShotIntervalRef.current);
      randomShotIntervalRef.current = null;
    }

    runningRef.current = false;
    setIsRunning(false);
    stopRecording();
    stopCamera();
    addLog("info", "Proctoring stopped");
  };

  const randomCameraShots = cameraShots.filter(
    (shot) => shot.reason === "Random camera snapshot",
  );

  const violationCameraShots = cameraShots.filter(
    (shot) => shot.reason !== "Random camera snapshot",
  );

  /* ---------------- UI ---------------- */
  return (
    <div className="min-h-screen bg-white p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            AI Proctoring System
          </h1>
          <p className="text-gray-600">
            Real-time exam monitoring with computer vision
          </p>
        </div>

        {/* <div className="flex w-full gap-20"> */}
        <div className="flex flex-col lg:flex-row w-full gap-6">
          {/* Camera Preview */}
          <div className="mb-8 border w-full  border-gray-300 rounded-lg overflow-hidden">
            <div className="bg-gray-100  px-4 py-3 border-b border-gray-300">
              <h2 className="text-lg font-semibold text-gray-900">
                🎥 Camera Preview
              </h2>
            </div>
            <div className="bg-black p-4 h-full">
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="w-full max-w-2xl mx-auto rounded-lg"
              />
            </div>
          </div>

          {/* Violation Logs */}
          <div className="mb-8 border w-full max-h-130 overflow-y-auto border-gray-300 rounded-lg overflow-hidden">
            <div className="bg-gray-100  px-4 py-3 border-b border-gray-300">
              <h2 className="text-lg font-semibold text-gray-900">
                ⚠️ Proctoring Alerts
              </h2>
            </div>
            <div className="bg-white p-4 max-h-auto overflow-y-auto">
              {logs.length === 0 && (
                <p className="text-gray-500 text-center py-4">
                  No violations detected
                </p>
              )}
              {logs.map((log, idx) => (
                <div
                  key={idx}
                  className={`mb-2 px-3 py-2 rounded text-sm font-medium ${log.type === "error"
                    ? "bg-red-50 text-red-700 border border-red-200"
                    : log.type === "warning"
                      ? "bg-yellow-50 text-yellow-700 border border-yellow-200"
                      : "bg-blue-50 text-blue-700 border border-blue-200"
                    }`}
                >
                  [{log.time}] {log.message}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Control Buttons */}
        <div className="flex gap-4 mb-8">
          <button
            onClick={startProctoring}
            disabled={isRunning}
            className="px-6 py-3 bg-emerald-600 text-white font-semibold rounded-lg hover:bg-emerald-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            ▶ Start Proctoring
          </button>
          <button
            onClick={stopProctoring}
            disabled={!isRunning}
            className="px-6 py-3 bg-red-600 text-white font-semibold rounded-lg hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            ⏹ Stop Proctoring
          </button>
        </div>

        {/* Camera Violation Shots Table */}
        {violationCameraShots.length > 0 && (
          <div className="mb-8 border border-gray-300 rounded-lg overflow-hidden">
            <div className="bg-gray-100 px-4 py-3 border-b border-gray-300">
              <h2 className="text-lg font-semibold text-gray-900">
                📷 Camera Violations
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-300">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-900 uppercase tracking-wider">
                      Sl No
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-900 uppercase tracking-wider">
                      Date & Time
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-900 uppercase tracking-wider">
                      Violation
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-900 uppercase tracking-wider">
                      Image
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {violationCameraShots.map((shot, idx) => (
                    <tr key={idx} className="hover:bg-gray-50">
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                        {idx + 1}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
                        {shot.time}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">
                        {shot.reason}
                      </td>
                      <td className="px-4 py-3">
                        <img
                          src={shot.url}
                          alt="violation"
                          className="w-32 h-24 object-cover rounded border border-gray-300"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Tab Switch Screenshots Table */}
        {screenshots.length > 0 && (
          <div className="mb-8 border border-gray-300 rounded-lg overflow-hidden">
            <div className="bg-gray-100 px-4 py-3 border-b border-gray-300">
              <h2 className="text-lg font-semibold text-gray-900">
                📸 Tab Switch Screenshots
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-300">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-900 uppercase tracking-wider">
                      Sl No
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-900 uppercase tracking-wider">
                      Date & Time
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-900 uppercase tracking-wider">
                      Violation
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-900 uppercase tracking-wider">
                      Image
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {screenshots.map((shot, idx) => (
                    <tr key={idx} className="hover:bg-gray-50">
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                        {idx + 1}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
                        {shot.time}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">
                        Tab switch detected
                      </td>
                      <td className="px-4 py-3">
                        <img
                          src={shot.url}
                          alt="tab switch"
                          className="w-32 h-24 object-cover rounded border border-gray-300"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Random Shots Table */}
        {randomCameraShots.length > 0 && (
          <div className="mb-8 border border-gray-300 rounded-lg overflow-hidden">
            <div className="bg-gray-100 px-4 py-3 border-b border-gray-300">
              <h2 className="text-lg font-semibold text-gray-900">
                📷 Random Shots
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-300">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-900 uppercase tracking-wider">
                      Sl No
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-900 uppercase tracking-wider">
                      Date & Time
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-900 uppercase tracking-wider">
                      Reason
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-900 uppercase tracking-wider">
                      Image
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {randomCameraShots.map((shot, idx) => (
                    <tr key={idx} className="hover:bg-gray-50">
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                        {idx + 1}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
                        {shot.time}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">
                        {shot.reason}
                      </td>
                      <td className="px-4 py-3">
                        <img
                          src={shot.url}
                          alt="violation"
                          className="w-32 h-24 object-cover rounded border border-gray-300"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Session Recording */}
        {sessionVideoUrl && (
          <div className="mb-8 border border-gray-300 rounded-lg overflow-hidden">
            <div className="bg-gray-100 px-4 py-3 border-b border-gray-300">
              <h2 className="text-lg font-semibold text-gray-900">
                📼 Session Recording
              </h2>
            </div>
            <div className="p-4 bg-white">
              <video
                src={sessionVideoUrl}
                controls
                className="w-full rounded-lg border border-gray-300"
              />
            </div>
          </div>
        )}
      </div>

      {/* Fullscreen Block Overlay */}
      {fullscreenBlocked && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-8 max-w-md text-center shadow-2xl">
            <div className="text-red-600 text-5xl mb-4">⚠</div>
            <h2 className="text-2xl font-bold text-gray-900 mb-4">
              Fullscreen Required
            </h2>
            <p className="text-gray-600 mb-6">
              Please re-enter fullscreen mode to continue the exam.
            </p>
            <button
              onClick={reEnterFullscreen}
              className="px-6 py-3 bg-emerald-600 text-white font-semibold rounded-lg hover:bg-emerald-700 transition-colors"
            >
              Re-enter Fullscreen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

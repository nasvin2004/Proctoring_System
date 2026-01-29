

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

type BrowserCompatibility = {
  isCompatible: boolean;
  browser: string;
  supportsFullscreen: boolean;
  supportsScreenCapture: boolean;
  supportsMediaDevices: boolean;
  needsUserGesture: boolean;
  issues: string[];
};

type SetupStep = {
  id: string;
  label: string;
  completed: boolean;
  error?: string;
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

  /*  RANDOM CAMERA SHOT INTERVAL */
  const randomShotIntervalRef = useRef<number | null>(null);

  /*  CAMERA SCREENSHOT COOLDOWN */
  const lastCameraShotByReasonRef = useRef<Record<string, number>>({});
  const CAMERA_SHOT_COOLDOWN_MS = 60_000; // 1 minute

  /*  RANDOM CAMERA SHOT COOLDOWN */
  const lastRandomShotTimeRef = useRef<number>(0);
  const RANDOM_SHOT_COOLDOWN_MS = 10_000; // 10 seconds

  /* ---------------- STATE ---------------- */
  const [isRunning, setIsRunning] = useState(false);
  const [fullscreenBlocked, setFullscreenBlocked] = useState(false);
  const [sessionVideoUrl, setSessionVideoUrl] = useState<string | null>(null);
  const [screenshots, setScreenshots] = useState<ScreenshotItem[]>([]);
  const [cameraShots, setCameraShots] = useState<CameraShotItem[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  
  // New states for setup flow
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [browserCompat, setBrowserCompat] = useState<BrowserCompatibility | null>(null);
  
  // IMPORTANT: Reordered setup steps - Fullscreen is now LAST!
  const [setupSteps, setSetupSteps] = useState<SetupStep[]>([
    { id: "browser", label: "Browser Compatibility Check", completed: false },
    { id: "camera", label: "Camera Access", completed: false },
    { id: "screenshare", label: "Screen Sharing", completed: false },
    { id: "models", label: "AI Models Loading", completed: false },
    { id: "fullscreen", label: "Fullscreen Mode", completed: false }, // MOVED TO LAST
  ]);
  const [currentSetupStep, setCurrentSetupStep] = useState(0);
  const [setupInProgress, setSetupInProgress] = useState(false);

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  /* ---------------- BROWSER COMPATIBILITY CHECK ---------------- */
  const checkBrowserCompatibility = (): BrowserCompatibility => {
    const ua = navigator.userAgent;
    const issues: string[] = [];
    
    // Detect OS
    const isLinux = /Linux|X11/i.test(ua);
    const isUbuntu = /Ubuntu/i.test(ua);
    
    // Detect browser
    let browser = "Unknown";
    let needsUserGesture = false;
    
    if (ua.includes("Chrome") && !ua.includes("Edg")) {
      browser = "Chrome";
      // Chrome on Linux/Ubuntu needs user gesture for fullscreen
      needsUserGesture = isLinux || isUbuntu || isMobile;
    } else if (ua.includes("Firefox")) {
      browser = "Firefox";
      needsUserGesture = true; // Firefox ALWAYS needs user gesture
    } else if (ua.includes("Safari") && !ua.includes("Chrome")) {
      browser = "Safari";
      needsUserGesture = true;
    } else if (ua.includes("Edg")) {
      browser = "Edge";
      needsUserGesture = isLinux || isUbuntu || isMobile;
    } else if (ua.includes("OPR") || ua.includes("Opera")) {
      browser = "Opera";
      needsUserGesture = isLinux || isUbuntu || isMobile;
    }

    // Check fullscreen API (check mozRequestFullScreen for Firefox first)
    const supportsFullscreen = !!(
      (document.documentElement as any).mozRequestFullScreen ||
      document.documentElement.requestFullscreen ||
      (document.documentElement as any).webkitRequestFullscreen ||
      (document.documentElement as any).webkitEnterFullscreen || // Mobile Safari
      (document.documentElement as any).msRequestFullscreen
    );

    if (!supportsFullscreen) {
      issues.push("Fullscreen API not supported");
    }

    // Check screen capture API
    const supportsScreenCapture = !!(
      navigator.mediaDevices?.getDisplayMedia
    );

    if (!supportsScreenCapture && !isMobile) {
      issues.push("Screen capture not supported");
    }

    // Check media devices
    const supportsMediaDevices = !!(
      navigator.mediaDevices?.getUserMedia
    );

    if (!supportsMediaDevices) {
      issues.push("Camera access not supported");
    }

    const isCompatible = 
      supportsFullscreen && 
      supportsMediaDevices && 
      (isMobile || supportsScreenCapture);

    return {
      isCompatible,
      browser,
      supportsFullscreen,
      supportsScreenCapture,
      supportsMediaDevices,
      needsUserGesture,
      issues,
    };
  };

  /* ---------------- LOGGING ---------------- */
  const addLog = (type: LogItem["type"], message: string) => {
    setLogs((prev) => [
      ...prev,
      { time: new Date().toLocaleTimeString(), type, message },
    ]);
  };

  const updateSetupStep = (stepId: string, completed: boolean, error?: string) => {
    setSetupSteps((prev) =>
      prev.map((step) =>
        step.id === stepId ? { ...step, completed, error } : step
      )
    );
  };

  /* ---------------- RANDOM CAMERA SHOT (SEPARATE COOLDOWN) ---------------- */
  const captureRandomShot = () => {
    if (!videoRef.current || !videoRef.current.videoWidth) return;

    const now = Date.now();

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
      0.7
    );
  };

  /* ---------------- CAMERA FRAME CAPTURE (PER-REASON COOLDOWN) ---------------- */
  const captureCameraFrame = (reason: string) => {
    if (!videoRef.current || !videoRef.current.videoWidth) return;

    const now = Date.now();
    const lastShotTime = lastCameraShotByReasonRef.current[reason] ?? 0;

    if (now - lastShotTime < CAMERA_SHOT_COOLDOWN_MS) {
      return;
    }

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
      0.7
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
        canvas.toBlob(res, "image/png")
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

  /* ---------------- SCREEN SHARE ---------------- */
  const requestScreenShare = async (): Promise<MediaStream | null> => {
    try {
      // Firefox sometimes needs specific constraints
      const constraints: DisplayMediaStreamOptions = {
        video: {
          frameRate: { ideal: 30, max: 30 },
        },
        audio: true,
      };

      const stream = await navigator.mediaDevices.getDisplayMedia(constraints);

      // Verify we got a valid stream
      if (!stream || stream.getVideoTracks().length === 0) {
        throw new Error("No video track in screen share stream");
      }

      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();

      addLog("info", `Screen shared: ${settings.displaySurface ?? "unknown"}`);

      // Handle stream ending (user clicks "Stop sharing" button in browser)
      track.onended = () => {
        addLog("warning", "Screen sharing stopped by user");
        if (runningRef.current) {
          setFullscreenBlocked(true);
        }
      };

      screenStreamRef.current = stream;
      return stream;
    } catch (err: any) {
      console.error("Screen share error:", err);
      
      // Different error types
      if (err.name === "NotAllowedError") {
        addLog("error", "Screen sharing permission denied");
      } else if (err.name === "AbortError") {
        addLog("warning", "Screen sharing cancelled by user");
      } else {
        addLog("error", `Screen sharing error: ${err.message}`);
      }
      
      return null;
    }
  };

  /* ---------------- RECORDING ---------------- */
  const getSupportedMimeType = (): string => {
    // List of MIME types to try, in order of preference
    const mimeTypes = [
      "video/webm; codecs=vp9",
      "video/webm; codecs=vp8",
      "video/webm; codecs=h264",
      "video/webm",
      "video/mp4; codecs=h264",
      "video/mp4",
    ];

    for (const mimeType of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        console.log(`Using MIME type: ${mimeType}`);
        return mimeType;
      }
    }

    // Fallback to default (browser will use its default codec)
    console.warn("No explicitly supported MIME type found, using browser default");
    return "";
  };

  const startRecording = (stream: MediaStream) => {
    recordedChunksRef.current = [];

    const mimeType = getSupportedMimeType();
    
    // Firefox needs to ensure tracks are active before recording
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack || videoTrack.readyState !== "live") {
      addLog("warning", "Waiting for screen share stream to become active...");
      // Wait for track to become live
      const checkTrack = () => {
        if (videoTrack && videoTrack.readyState === "live") {
          initializeRecorder(stream, mimeType);
        } else {
          setTimeout(checkTrack, 100);
        }
      };
      checkTrack();
      return;
    }
    
    initializeRecorder(stream, mimeType);
  };

  const initializeRecorder = (stream: MediaStream, mimeType: string) => {
    try {
      // Create recorder with supported MIME type, or without options if none found
      const recorderOptions = mimeType ? { mimeType } : undefined;
      const recorder = new MediaRecorder(stream, recorderOptions);

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, {
          type: mimeType || "video/webm",
        });

        const url = URL.createObjectURL(blob);
        setSessionVideoUrl(url);

        addLog("info", "Session recording saved");
      };

      recorder.onerror = (event: any) => {
        console.error("MediaRecorder error:", event);
        addLog("error", `Recording error: ${event.error?.message || "Unknown error"}`);
      };

      recorder.start();
      recorderRef.current = recorder;
      addLog("info", `Session recording started with ${mimeType || "default codec"}`);
    } catch (error: any) {
      console.error("Failed to initialize MediaRecorder:", error);
      addLog("error", `Recording initialization failed: ${error.message}`);
    }
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
  const requestFullscreenSync = () => {
    // FIREFOX REQUIREMENT: Sync call, no await!
    const elem = document.documentElement;
    let fullscreenPromise: Promise<void> | null = null;
    
    // Call fullscreen synchronously
    try {
      // Try different fullscreen APIs
      if ((elem as any).mozRequestFullScreen) {
        fullscreenPromise = (elem as any).mozRequestFullScreen();
      } else if (elem.requestFullscreen) {
        fullscreenPromise = elem.requestFullscreen();
      } else if ((elem as any).webkitRequestFullscreen) {
        fullscreenPromise = (elem as any).webkitRequestFullscreen();
      } else if ((elem as any).webkitEnterFullscreen) {
        // Mobile Safari
        fullscreenPromise = (elem as any).webkitEnterFullscreen();
      } else if ((elem as any).msRequestFullscreen) {
        fullscreenPromise = (elem as any).msRequestFullscreen();
      }
    } catch (error) {
      console.error("Fullscreen call error:", error);
    }
    
    return fullscreenPromise;
  };

  const reEnterFullscreen = () => {
    const fullscreenPromise = requestFullscreenSync();
    
    // Handle result asynchronously
    setTimeout(() => {
      if (fullscreenPromise) {
        fullscreenPromise
          .then(() => {
            setFullscreenBlocked(false);
            addLog("info", "Fullscreen re-entered");
          })
          .catch((error) => {
            console.error("Fullscreen re-entry failed:", error);
            addLog("warning", "Fullscreen request denied");
          });
      } else {
        addLog("warning", "Fullscreen API not available");
      }
    }, 0);
  };

  /* ---------------- SETUP FLOW ---------------- */
  const startSetupFlow = () => {
    setShowSetupModal(true);
    setCurrentSetupStep(0);
    setSetupSteps((prev) =>
      prev.map((step) => ({ ...step, completed: false, error: undefined }))
    );
    
    // Start with browser check
    const compat = checkBrowserCompatibility();
    setBrowserCompat(compat);
    
    if (compat.isCompatible) {
      updateSetupStep("browser", true);
      addLog("info", `Browser compatible: ${compat.browser}`);
    } else {
      updateSetupStep("browser", false, compat.issues.join(", "));
      addLog("error", `Browser compatibility issues: ${compat.issues.join(", ")}`);
    }
  };

  const runSetupStep = async (stepIndex: number) => {
    if (setupInProgress) return;
    
    setSetupInProgress(true);
    setCurrentSetupStep(stepIndex);
    
    const step = setupSteps[stepIndex];
    
    // Clear any previous error for this step
    if (step.error) {
      updateSetupStep(step.id, false, undefined);
    }
    
    try {
      switch (step.id) {
        case "browser":
          // Re-check browser compatibility
          const compat = checkBrowserCompatibility();
          setBrowserCompat(compat);
          
          if (compat.isCompatible) {
            updateSetupStep("browser", true);
            addLog("info", `Browser compatible: ${compat.browser}`);
          } else {
            updateSetupStep("browser", false, compat.issues.join(", "));
            addLog("error", `Browser compatibility issues: ${compat.issues.join(", ")}`);
            setSetupInProgress(false);
            return;
          }
          break;
          
        case "camera":
          addLog("info", "Requesting camera access...");
          try {
            const cameraStream = await navigator.mediaDevices.getUserMedia({
              video: true,
            });
            cameraStreamRef.current = cameraStream;
            if (videoRef.current) {
              videoRef.current.srcObject = cameraStream;
            }
            updateSetupStep("camera", true);
            addLog("info", "Camera access granted");
          } catch (error: any) {
            updateSetupStep("camera", false, error.message);
            addLog("error", `Camera access failed: ${error.message}`);
            setSetupInProgress(false);
            return;
          }
          break;
          
        case "screenshare":
          if (isMobile) {
            addLog("warning", "Screen sharing skipped (mobile device)");
            updateSetupStep("screenshare", true);
          } else {
            addLog("info", "Requesting screen sharing...");
            try {
              const screenStream = await requestScreenShare();
              if (screenStream) {
                // Wait a bit for stream to be ready (Firefox needs this)
                await new Promise(resolve => setTimeout(resolve, 500));
                startRecording(screenStream);
                updateSetupStep("screenshare", true);
                addLog("info", "Screen sharing started");
              } else {
                // User cancelled or denied permission
                updateSetupStep("screenshare", false, "Screen sharing cancelled");
                addLog("warning", "Screen sharing was cancelled. Please try again.");
                setSetupInProgress(false);
                return;
              }
            } catch (error: any) {
              // Handle screen share errors gracefully
              updateSetupStep("screenshare", false, error.message);
              addLog("error", `Screen sharing failed: ${error.message}`);
              setSetupInProgress(false);
              return;
            }
          }
          break;
          
        case "models":
          addLog("info", "Loading AI models (this may take a moment)...");
          try {
            await loadFaceLandmarker();
            await loadObjectModel();
            updateSetupStep("models", true);
            addLog("info", "AI models loaded successfully");
          } catch (error: any) {
            updateSetupStep("models", false, error.message);
            addLog("error", `AI models loading failed: ${error.message}`);
            setSetupInProgress(false);
            return;
          }
          break;
          
        case "fullscreen":
          addLog("info", "Requesting fullscreen mode...");
          if (browserCompat?.needsUserGesture) {
            // Show button for user to click
            addLog("info", "Please click the 'Enter Fullscreen' button");
            setSetupInProgress(false);
            return;
          } else {
            // Auto-trigger for Chrome on Windows/Mac
            const fullscreenPromise = requestFullscreenSync();
            
            if (fullscreenPromise) {
              fullscreenPromise
                .then(() => {
                  updateSetupStep("fullscreen", true);
                  addLog("info", "Fullscreen mode activated");
                  tabSwitchGraceUntilRef.current = Date.now() + 1000;
                  setSetupInProgress(false);
                })
                .catch((error) => {
                  console.error("Auto fullscreen failed:", error);
                  updateSetupStep("fullscreen", false, "Click button to enter fullscreen");
                  addLog("warning", "Auto fullscreen failed, please use the button");
                  setSetupInProgress(false);
                  return;
                });
              return; // Don't set setupInProgress to false yet
            } else {
              updateSetupStep("fullscreen", false, "Click button to enter fullscreen");
              addLog("warning", "Fullscreen API not available, please use the button");
              setSetupInProgress(false);
              return;
            }
          }
          break;
      }
      
      setSetupInProgress(false);
      
      // Auto-advance to next step if not fullscreen with user gesture needed
      if (stepIndex < setupSteps.length - 1) {
        setTimeout(() => runSetupStep(stepIndex + 1), 500);
      }
    } catch (error: any) {
      console.error(`Setup step ${step.id} failed:`, error);
      updateSetupStep(step.id, false, error.message);
      addLog("error", `${step.label} failed: ${error.message}`);
      setSetupInProgress(false);
    }
  };

  const handleFullscreenButtonClick = () => {
    // CRITICAL FOR FIREFOX: Sync call, no async operations before!
    const fullscreenPromise = requestFullscreenSync();
    
    // Handle result asynchronously
    setTimeout(() => {
      if (fullscreenPromise) {
        fullscreenPromise
          .then(() => {
            updateSetupStep("fullscreen", true);
            addLog("info", "Fullscreen mode activated");
            tabSwitchGraceUntilRef.current = Date.now() + 1000;
            setSetupInProgress(false);
            
            // Continue to next step if any
            const currentIndex = setupSteps.findIndex((s) => s.id === "fullscreen");
            if (currentIndex < setupSteps.length - 1) {
              setTimeout(() => runSetupStep(currentIndex + 1), 500);
            }
          })
          .catch((error) => {
            console.error("Fullscreen button click failed:", error);
            updateSetupStep("fullscreen", false, "Fullscreen request denied");
            addLog("error", "Fullscreen request denied");
            setSetupInProgress(false);
          });
      } else {
        updateSetupStep("fullscreen", false, "Fullscreen API not available");
        addLog("error", "Fullscreen API not available");
        setSetupInProgress(false);
      }
    }, 0);
  };

  const completeSetup = async () => {
    setShowSetupModal(false);
    setIsRunning(true);
    runningRef.current = true;
    
    addLog("info", "Proctoring started - Test in progress");
    
    // Load landmarker again to ensure it's ready
    const landmarker = await loadFaceLandmarker();
    
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

    // Start random camera snapshots
    randomShotIntervalRef.current = window.setInterval(() => {
      if (!runningRef.current) return;
      captureRandomShot();
    }, RANDOM_SHOT_COOLDOWN_MS);

    loop();
  };

  /* ---------------- START PROCTORING (TRIGGERS SETUP) ---------------- */
  const startProctoring = () => {
    if (runningRef.current) return;
    
    setLogs([]);
    setScreenshots([]);
    setCameraShots([]);
    setSessionVideoUrl(null);
    
    startSetupFlow();
  };

  /* ---------------- STOP PROCTORING ---------------- */
  const stopProctoring = () => {
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
    (shot) => shot.reason === "Random camera snapshot"
  );

  const violationCameraShots = cameraShots.filter(
    (shot) => shot.reason !== "Random camera snapshot"
  );

  const allStepsCompleted = setupSteps.every((step) => step.completed);

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

        <div className="flex flex-col lg:flex-row w-full gap-6">
          {/* Camera Preview */}
          <div className="mb-8 border w-full border-gray-300 rounded-lg overflow-hidden">
            <div className="bg-gray-100 px-4 py-3 border-b border-gray-300">
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
            <div className="bg-gray-100 px-4 py-3 border-b border-gray-300">
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
                  className={`mb-2 px-3 py-2 rounded text-sm font-medium ${
                    log.type === "error"
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
                          alt="random shot"
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

      {/* Setup Modal */}
      {showSetupModal && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-8 max-w-2xl w-full shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                System Setup
              </h2>
              <p className="text-gray-600">
                Setting up your proctoring environment...
              </p>
              <p className="text-sm text-blue-600 mt-2">
                ℹ️ Fullscreen will be activated LAST to prevent interruptions from permission popups
              </p>
              {browserCompat?.needsUserGesture && (
                <p className="text-sm text-orange-600 mt-1">
                  {browserCompat.browser === "Firefox" && "🦊 "}
                  {/Linux|Ubuntu/i.test(navigator.userAgent) && "🐧 "}
                  {isMobile && "📱 "}
                  You'll need to click "Enter Fullscreen" button when ready
                </p>
              )}
            </div>

            {/* Browser Compatibility Info */}
            {browserCompat && (
              <div className={`mb-6 p-4 rounded-lg border ${
                browserCompat.isCompatible
                  ? "bg-green-50 border-green-200"
                  : "bg-red-50 border-red-200"
              }`}>
                <div className="flex items-center mb-2">
                  <span className="text-2xl mr-3">
                    {browserCompat.isCompatible ? "✅" : "❌"}
                  </span>
                  <div>
                    <p className="font-semibold text-gray-900">
                      Browser: {browserCompat.browser} {isMobile && "(Mobile)"}
                    </p>
                    <p className="text-sm text-gray-600">
                      {browserCompat.needsUserGesture
                        ? "User click required for fullscreen"
                        : "Fullscreen can be auto-triggered"}
                    </p>
                  </div>
                </div>
                {browserCompat.issues.length > 0 && (
                  <div className="mt-2">
                    <p className="text-sm font-semibold text-red-700 mb-1">
                      Issues:
                    </p>
                    <ul className="text-sm text-red-600 list-disc list-inside">
                      {browserCompat.issues.map((issue, idx) => (
                        <li key={idx}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* Setup Steps */}
            <div className="space-y-3 mb-6">
              {setupSteps.map((step, idx) => (
                <div
                  key={step.id}
                  className={`p-4 rounded-lg border ${
                    step.completed
                      ? "bg-green-50 border-green-200"
                      : step.error
                      ? "bg-red-50 border-red-200"
                      : idx === currentSetupStep
                      ? "bg-blue-50 border-blue-200"
                      : "bg-gray-50 border-gray-200"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center flex-1">
                      <span className="text-2xl mr-3">
                        {step.completed
                          ? "✅"
                          : step.error
                          ? "❌"
                          : idx === currentSetupStep
                          ? "🔄"
                          : "⏳"}
                      </span>
                      <div className="flex-1">
                        <p className="font-semibold text-gray-900">
                          {idx + 1}. {step.label}
                        </p>
                        {step.error && (
                          <p className="text-sm text-red-600">{step.error}</p>
                        )}
                      </div>
                    </div>
                    
                    {/* Show fullscreen button when on fullscreen step and needs user gesture OR has error */}
                    {step.id === "fullscreen" &&
                      idx === currentSetupStep &&
                      !step.completed &&
                      (browserCompat?.needsUserGesture || step.error) && (
                        <button
                          onClick={handleFullscreenButtonClick}
                          disabled={setupInProgress}
                          className="ml-3 px-4 py-2 bg-blue-600 text-white font-semibold rounded hover:bg-blue-700 disabled:bg-gray-400 transition-colors whitespace-nowrap"
                        >
                          Enter Fullscreen
                        </button>
                      )}
                    
                    {/* Show retry button for failed non-fullscreen steps */}
                    {step.error && step.id !== "fullscreen" && idx === currentSetupStep && (
                      <button
                        onClick={() => runSetupStep(idx)}
                        disabled={setupInProgress}
                        className="ml-3 px-4 py-2 bg-orange-600 text-white font-semibold rounded hover:bg-orange-700 disabled:bg-gray-400 transition-colors whitespace-nowrap"
                      >
                        🔄 Retry
                      </button>
                    )}
                    
                    {/* Show retry button for completed browser check (allow re-checking) */}
                    {step.id === "browser" && step.completed && idx === currentSetupStep && (
                      <button
                        onClick={() => runSetupStep(idx)}
                        disabled={setupInProgress}
                        className="ml-3 px-4 py-2 bg-gray-500 text-white font-semibold rounded hover:bg-gray-600 disabled:bg-gray-400 transition-colors whitespace-nowrap text-sm"
                      >
                        Re-check
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Action Buttons */}
            <div className="flex gap-4">
              {!allStepsCompleted && currentSetupStep === 0 && (
                <button
                  onClick={() => runSetupStep(0)}
                  disabled={setupInProgress || !browserCompat?.isCompatible}
                  className="flex-1 px-6 py-3 bg-emerald-600 text-white font-semibold rounded-lg hover:bg-emerald-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                >
                  Begin Setup
                </button>
              )}
              
              {allStepsCompleted && (
                <button
                  onClick={completeSetup}
                  className="flex-1 px-6 py-3 bg-emerald-600 text-white font-semibold rounded-lg hover:bg-emerald-700 transition-colors"
                >
                  🚀 Start Test
                </button>
              )}
              
              <button
                onClick={() => {
                  setShowSetupModal(false);
                  stopCamera();
                  if (screenStreamRef.current) {
                    screenStreamRef.current.getTracks().forEach((t) => t.stop());
                    screenStreamRef.current = null;
                  }
                }}
                className="px-6 py-3 bg-gray-600 text-white font-semibold rounded-lg hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

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

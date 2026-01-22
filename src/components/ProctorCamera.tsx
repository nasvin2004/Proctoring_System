
import { useEffect, useRef } from "react";
import { loadFaceLandmarker } from "../ml/faceLandmarker";
import { extractHeadPose } from "../ml/headPose";
import { classifyHeadPose } from "../ml/headClassifier";
import { detectGaze } from "../ml/gazeDetector";
import { decideMalpractice } from "../ml/headDecision";


import { loadObjectModel, detectObjects } from "../ml/objectDetector";

export default function ProctorCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let running = true;

    // ---------- TEMPORAL STATE ----------
    let faceLostAlerted = false;
    let objectFrame = 0;

    async function start() {
      // ---------- CAMERA ----------
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (videoRef.current) videoRef.current.srcObject = stream;

      // ---------- LOAD MODELS ----------
      const landmarker = await loadFaceLandmarker();
      await loadObjectModel(); // 🔴 load once

      // ---------- LOOP ----------
      const loop = async () => {
        if (!running || !videoRef.current) return;

        const now = performance.now();
        const result = landmarker.detectForVideo(videoRef.current, now);

        const faceCount = result.faceLandmarks.length;

        // ---------- FACE LOST ----------
        if (faceCount === 0) {
          if (!faceLostAlerted) {
            console.warn("❌ Face not detected");
            faceLostAlerted = true;
          }
          requestAnimationFrame(loop);
          return;
        }

        faceLostAlerted = false;

        // ---------- MULTIPLE FACES ----------
        if (faceCount > 1) {
          console.warn(`🚨 Multiple persons detected (${faceCount})`);
        }

        // ---------- HEAD + GAZE ----------
        const landmarks = result.faceLandmarks[0];
        const matrix = result.facialTransformationMatrixes[0].data;

        const { yaw, pitch, roll } = extractHeadPose(matrix);
        const head = classifyHeadPose(yaw, pitch, roll);
        const gaze = detectGaze(landmarks);

        const alert = decideMalpractice(head, gaze);

        if (alert?.headViolation) {
          console.warn("🚨 Head deviation sustained >2s");
        }
        if (alert?.gazeViolation) {
          console.warn("🚨 Gaze deviation sustained >2s");
        }

        // ---------- OBJECT DETECTION (1 FPS) ----------
        if (objectFrame++ % 60 === 0) {
          const objects = await detectObjects(videoRef.current);

          objects.forEach(obj => {
            console.warn(`🚨 Object detected: ${obj}`);
          });
        }

        requestAnimationFrame(loop);
      };

      loop();
    }

    start();

    return () => {
      running = false;
    };
  }, []);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      style={{ width: "100%", maxWidth: 640 }}
    />
  );
}

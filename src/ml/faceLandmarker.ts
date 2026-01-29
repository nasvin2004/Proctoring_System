import {
  FaceLandmarker,
  FilesetResolver
} from "@mediapipe/tasks-vision";

let faceLandmarker: FaceLandmarker | null = null;

export async function loadFaceLandmarker() {
  if (faceLandmarker) return faceLandmarker;

  // ✅ Load MediaPipe WASM from LOCAL files (not CDN)
  const vision = await FilesetResolver.forVisionTasks("/mediapipe");

  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      // ✅ Load model from local public folder
      modelAssetPath: "/mediapipe/face_landmarker.task",

      // ✅ GPU when available, auto-fallback to CPU
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 5,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true,
  });

  return faceLandmarker;
}

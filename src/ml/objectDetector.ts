import * as ort from "onnxruntime-web";

ort.env.wasm.numThreads = 1;

const MODEL_URL = "/objectDetection.onnx";
const SIZE = 640;

const CLASSES = ["book", "laptop", "phone", "tab", "watch"];

const VIOLATION_OBJECTS = new Set([
  "phone",
  "laptop",
  "tab",
  "book",
  "watch",
]);

let session: ort.InferenceSession | null = null;

/* ---------------- LOAD MODEL ---------------- */
export async function loadObjectModel() {
  if (session) return session;

  session = await ort.InferenceSession.create(MODEL_URL, {
    executionProviders: ["wasm"],
  });

  console.log("ONNX object model loaded");
  return session;
}

/* ---------------- PREPROCESS ---------------- */
function preprocess(source: HTMLVideoElement) {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;

  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, SIZE, SIZE);

  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
  const floatData = new Float32Array(3 * SIZE * SIZE);

  for (let i = 0; i < SIZE * SIZE; i++) {
    floatData[i] = data[i * 4] / 255;
    floatData[i + SIZE * SIZE] = data[i * 4 + 1] / 255;
    floatData[i + 2 * SIZE * SIZE] = data[i * 4 + 2] / 255;
  }

  return new ort.Tensor("float32", floatData, [1, 3, SIZE, SIZE]);
}

/* ---------------- DETECTION ---------------- */
export async function detectObjects(
  video: HTMLVideoElement
): Promise<string[]> {
  if (!session) await loadObjectModel();
  if (!video.videoWidth) return [];

  const inputTensor = preprocess(video);

  const feeds = {
    [session!.inputNames[0]]: inputTensor,
  };

  const output = await session!.run(feeds);
  const data =
    output[session!.outputNames[0]].data as Float32Array;

  const boxes = 8400;
  const threshold = 0.4;

  const detected = new Set<string>();

  for (let i = 0; i < boxes; i++) {
    let maxScore = 0;
    let classId = -1;

    for (let c = 0; c < CLASSES.length; c++) {
      const score = data[(4 + c) * boxes + i];
      if (score > maxScore) {
        maxScore = score;
        classId = c;
      }
    }

    if (
      maxScore > threshold &&
      VIOLATION_OBJECTS.has(CLASSES[classId])
    ) {
      detected.add(CLASSES[classId]);
    }
  }

  return [...detected];
}

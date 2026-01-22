import * as cocoSsd from "@tensorflow-models/coco-ssd";
import "@tensorflow/tfjs";

let model: cocoSsd.ObjectDetection | null = null;

const VIOLATION_OBJECTS = new Set([
  "cell phone",
  "laptop",
  "book",
  "keyboard",
  "mouse"
]);

export async function loadObjectModel() {
  if (model) return model;
  model = await cocoSsd.load({
    base: "mobilenet_v2"
  });
  return model;
}

export async function detectObjects(
  video: HTMLVideoElement
): Promise<string[]> {
  if (!model) await loadObjectModel();

  const predictions = await model!.detect(video);

  return predictions
    .filter(
      p =>
        p.score > 0.6 &&
        VIOLATION_OBJECTS.has(p.class)
    )
    .map(p => p.class);
}

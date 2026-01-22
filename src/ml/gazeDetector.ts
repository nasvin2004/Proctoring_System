export type GazeStatus =
  | "center"
  | "looking_left"
  | "looking_right";

export function detectGaze(landmarks: any[]): GazeStatus {
  const LEFT_EYE = [33, 133];
  const RIGHT_EYE = [362, 263];

  const LEFT_IRIS = [468, 469, 470, 471];
  const RIGHT_IRIS = [473, 474, 475, 476];

  function eyeRatio(eye: number[], iris: number[]) {
    const left = landmarks[eye[0]].x;
    const right = landmarks[eye[1]].x;
    const irisX =
      iris.reduce((s, i) => s + landmarks[i].x, 0) / iris.length;

    return (irisX - left) / (right - left);
  }

  const hRatio =
    (eyeRatio(LEFT_EYE, LEFT_IRIS) +
      eyeRatio(RIGHT_EYE, RIGHT_IRIS)) /
    2;

  if (hRatio < 0.35) return "looking_left";
  if (hRatio > 0.65) return "looking_right";
  return "center";
}

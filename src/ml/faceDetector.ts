import { FaceMesh } from "@mediapipe/face_mesh";

export type FaceResult = {
  count: number;
  landmarks: any[];
};

export class FaceDetector {
  private mesh: FaceMesh;

  constructor(onResult: (r: FaceResult) => void) {
    this.mesh = new FaceMesh({
      locateFile: (f) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`,
    });

    this.mesh.setOptions({
      maxNumFaces: 5,
      refineLandmarks: true,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });

    this.mesh.onResults((res) => {
      const faces = res.multiFaceLandmarks || [];
      onResult({
        count: faces.length,
        landmarks: faces,
      });
    });
  }

  async process(video: HTMLVideoElement) {
    await this.mesh.send({ image: video });
  }
}

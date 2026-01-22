export type HeadStatus =
  | "straight"
  | "head_turned"
  | "head_up_down"
  | "head_tilted";

export function classifyHeadPose(
  yaw: number,
  pitch: number,
  roll: number
): HeadStatus {
  if (Math.abs(yaw) > 25) return "head_turned";
  if (Math.abs(pitch) > 20) return "head_up_down";
  if (Math.abs(roll) > 15) return "head_tilted";
  return "straight";
}

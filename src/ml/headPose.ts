export function extractHeadPose(matrix: number[]) {
  
  const  m02 = matrix[2];
  const m10 = matrix[4], m11 = matrix[5], m12 = matrix[6];
  const  m22 = matrix[10];

  const yaw = Math.atan2(m02, m22) * (180 / Math.PI);
  const pitch =
    Math.atan2(-m12, Math.sqrt(m10 * m10 + m11 * m11)) *
    (180 / Math.PI);
  const roll = Math.atan2(m10, m11) * (180 / Math.PI);

  return { yaw, pitch, roll };
}

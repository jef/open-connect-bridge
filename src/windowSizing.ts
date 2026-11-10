export function contentHeightForScreen(
  requestedHeight: number,
  frameHeight: number,
  workAreaHeight: number,
): number {
  return Math.min(Math.ceil(requestedHeight), Math.max(1, workAreaHeight - frameHeight));
}

export function snapToGrid(value: number, snapSize: number): number {
  return Math.round(value / snapSize) * snapSize;
}

export class FrameSize {
  private requested: [number, number] | null = null;
  private applied: [number, number] | null = null;

  request(width: number, height: number) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return;
    this.requested = [Math.floor(width), Math.floor(height)];
  }

  apply(resize: (width: number, height: number) => void) {
    const next = this.requested;
    if (!next || (next[0] === this.applied?.[0] && next[1] === this.applied?.[1])) return;
    resize(next[0], next[1]);
    this.applied = next;
  }
}

/** Calls `onTimeout` once when `restart` is not called again within `ms`; starts running when created. */
export class IdleTimer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private didFire = false;

  constructor(
    private readonly ms: number,
    private readonly onTimeout: () => void,
  ) {
    this.restart();
  }

  get fired(): boolean {
    return this.didFire;
  }

  restart(): void {
    if (this.didFire) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.didFire = true;
      this.onTimeout();
    }, this.ms);
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

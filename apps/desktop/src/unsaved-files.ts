/** A hidden renderer with unsaved buffers must survive the warm-window timeout. */
export class UnsavedFiles<T extends object> {
  private readonly dirty = new WeakSet<T>();
  set(window: T, value: unknown) {
    if (typeof value !== "boolean") throw new Error("Invalid unsaved state.");
    if (value) this.dirty.add(window);
    else this.dirty.delete(window);
  }
  has(window: T) {
    return this.dirty.has(window);
  }
}

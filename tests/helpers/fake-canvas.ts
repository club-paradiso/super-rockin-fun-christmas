import type { CanvasFactory, CanvasLike } from "@/lib/canvas";

export interface DrawCall {
  name: string;
  args: unknown[];
}

/**
 * Recording stand-in for <canvas> (jsdom has no 2D context). Every context method call is
 * logged; property writes (fillStyle, font…) are stored and readable.
 */
export class FakeCanvas implements CanvasLike {
  readonly calls: DrawCall[] = [];
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    public width: number,
    public height: number,
  ) {
    const calls = this.calls;
    const props: Record<string | symbol, unknown> = {};
    this.ctx = new Proxy(props, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === "createLinearGradient") {
          return (...args: unknown[]) => {
            calls.push({ name: "createLinearGradient", args });
            return { addColorStop: () => undefined };
          };
        }
        return (...args: unknown[]) => {
          calls.push({ name: String(prop), args });
        };
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  }

  getContext(): CanvasRenderingContext2D {
    return this.ctx;
  }

  callsTo(name: string): DrawCall[] {
    return this.calls.filter((c) => c.name === name);
  }
}

export function fakeCanvasFactory() {
  const created: FakeCanvas[] = [];
  const factory: CanvasFactory = (w, h) => {
    const canvas = new FakeCanvas(Math.round(w), Math.round(h));
    created.push(canvas);
    return canvas;
  };
  return { factory, created };
}

export type InputManager = {
  isKeyDown(key: string): boolean;
  getMouseDelta(): { x: number; y: number };
  consumeMouseDelta(): void;
  dispose(): void;
};

export function createInputManager(): InputManager {
  const keys = new Set<string>();
  let mouseDX = 0;
  let mouseDY = 0;
  let isMouseDown = false;

  const onKeyDown = (e: KeyboardEvent): void => { keys.add(e.code); };
  const onKeyUp   = (e: KeyboardEvent): void => { keys.delete(e.code); };
  const onMouseDown = (e: MouseEvent): void => { if (e.button === 0) isMouseDown = true; };
  const onMouseUp   = (e: MouseEvent): void => { if (e.button === 0) isMouseDown = false; };
  const onMouseMove = (e: MouseEvent): void => {
    if (!isMouseDown) return;
    mouseDX += e.movementX;
    mouseDY += e.movementY;
  };

  document.addEventListener('keydown',   onKeyDown);
  document.addEventListener('keyup',     onKeyUp);
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup',   onMouseUp);
  document.addEventListener('mousemove', onMouseMove);

  return {
    isKeyDown: (key) => keys.has(key),
    getMouseDelta: () => ({ x: mouseDX, y: mouseDY }),
    consumeMouseDelta: () => { mouseDX = 0; mouseDY = 0; },
    dispose: () => {
      document.removeEventListener('keydown',   onKeyDown);
      document.removeEventListener('keyup',     onKeyUp);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup',   onMouseUp);
      document.removeEventListener('mousemove', onMouseMove);
    },
  };
}

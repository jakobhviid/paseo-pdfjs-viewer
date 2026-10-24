// Holds the web runtime's cleanup without importing it, so the client entry can release the PDF.js
// worker and stylesheet on unload while native never loads client/web/.
let release: (() => void) | null = null;

export function setRuntimeRelease(next: (() => void) | null): void {
  release = next;
}

export function releaseRuntime(): void {
  const current = release;
  release = null;
  current?.();
}

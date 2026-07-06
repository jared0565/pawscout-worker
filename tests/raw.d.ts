// Vite/vitest `?raw` imports resolve to the file's text at build time.
// Used by system-states.test.ts to pin the states registry to docs/STATES.md.
declare module '*?raw' {
  const text: string;
  export default text;
}

import fs from 'node:fs';
import { digest } from './analysis-facts.mjs';

export function runtimeFingerprint() {
  return digest(
    [
      './flow.mjs',
      './flow-runtime.mjs',
      './flow-instrument-javascript.mjs',
      './flow-instrument-foreign.mjs',
      './flow-browser.mjs',
      './component-observation.mjs',
      '../assets/runtime/node-probe.mjs',
      '../assets/runtime/browser-probe.js',
      '../assets/runtime/python-probe.py',
      '../assets/runtime/go-probe.go.txt',
      '../assets/runtime/cpp-probe.hpp',
      '../assets/analyzers/python-instrument.py',
    ]
      .map((file) => fs.readFileSync(new URL(file, import.meta.url)))
      .join(''),
  );
}

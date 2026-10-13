import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const templatePath = fileURLToPath(new URL('../assets/template.html', import.meta.url));
const sources = {
  BLUEPRINT_THEME: 'theme.js',
  BLUEPRINT_STYLES: 'styles.css',
  BLUEPRINT_CLIENT: 'client.js',
};

// Keep editable sources separate; deliver one HTML with all assets inlined.
export function loadTemplate(filename = templatePath) {
  const shell = fs.readFileSync(filename, 'utf8');
  const embedded = new Map();
  for (const [slot, source] of Object.entries(sources)) {
    const marker = `{{${slot}}}`;
    if (shell.split(marker).length !== 2) throw new Error(`固定模板的 ${slot} 位置不完整。`);
    embedded.set(slot, fs.readFileSync(path.join(path.dirname(filename), source), 'utf8'));
  }
  return shell.replace(/\{\{(BLUEPRINT_THEME|BLUEPRINT_STYLES|BLUEPRINT_CLIENT)\}\}/g, (_, slot) =>
    embedded.get(slot),
  );
}

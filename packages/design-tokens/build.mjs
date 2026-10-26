// Generates platform token files from tokens.json. `--check` fails if outputs are stale (used in CI).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const t = JSON.parse(readFileSync(join(here, 'tokens.json'), 'utf8'));
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const header = 'Generated from packages/design-tokens/tokens.json. Do not edit by hand.';

function css() {
  const vars = (obj) => Object.entries(obj).map(([k, v]) => `  --color-${kebab(k)}: ${v};`).join('\n');
  const scalar = (group, unit = 'px') => Object.entries(t[group]).map(([k, v]) => `  --${group}-${kebab(k)}: ${v}${unit};`).join('\n');
  const fontSizes = Object.entries(t.font.size).map(([k, v]) => `  --font-size-${k}: ${v}px;`).join('\n');
  return `/* ${header} */
:root {
${vars(t.color.light)}
${scalar('space')}
${scalar('radius')}
  --font-family: ${t.font.family};
${fontSizes}
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
${vars(t.color.dark).replace(/^/gm, '  ')}
    color-scheme: dark;
  }
}
:root[data-theme='dark'] {
${vars(t.color.dark)}
  color-scheme: dark;
}
`;
}

function dart() {
  const hex = (v) => `Color(0xFF${v.slice(1).toUpperCase()})`;
  const palette = (name, obj) =>
    `  static const ${name} = NexaPalette(\n${Object.entries(obj).map(([k, v]) => `    ${k}: ${hex(v)},`).join('\n')}\n  );`;
  const fields = Object.keys(t.color.light);
  const nums = (group) => Object.entries(t[group]).map(([k, v]) => `  static const double ${k} = ${v};`).join('\n');
  return `// ${header}
// ignore_for_file: public_member_api_docs
import 'package:flutter/painting.dart';

class NexaPalette {
  const NexaPalette({
${fields.map((f) => `    required this.${f},`).join('\n')}
  });
${fields.map((f) => `  final Color ${f};`).join('\n')}
}

class NexaColors {
${palette('light', t.color.light)}
${palette('dark', t.color.dark)}
}

class NexaSpace {
${nums('space')}
}

class NexaRadius {
${nums('radius')}
}

class NexaFontSize {
${Object.entries(t.font.size).map(([k, v]) => `  static const double ${k} = ${v};`).join('\n')}
}
`;
}

const outputs = {
  [join(here, '..', '..', 'apps', 'web', 'app', 'tokens.css')]: css(),
  [join(here, '..', '..', 'apps', 'mobile', 'lib', 'theme', 'tokens.g.dart')]: dart(),
};

const check = process.argv.includes('--check');
let stale = false;
for (const [path, content] of Object.entries(outputs)) {
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
      console.error(`Stale: ${path}. Run pnpm tokens.`);
      stale = true;
    }
  } else {
    writeFileSync(path, content);
    console.log(`Wrote ${path}`);
  }
}
if (stale) process.exit(1);

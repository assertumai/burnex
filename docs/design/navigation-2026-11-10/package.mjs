import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('./', import.meta.url);
const [html, css, js] = await Promise.all(
  ['index.html', 'styles.css', 'prototype.js'].map(name => readFile(new URL(name, root), 'utf8')),
);
const scriptHash = createHash('sha256').update(js).digest('base64');
const standalone = html
  .replace("script-src 'self'", `script-src 'sha256-${scriptHash}'`)
  .replace('  <link rel="stylesheet" href="styles.css">', `<style>\n${css}\n</style>`)
  .replace('  <script src="prototype.js" defer></script>', '')
  .replace('</body>', `<script>${js}</script>\n</body>`);
const output = new URL('burnex-navigation.html', root);
await writeFile(output, standalone);
console.log(`Packaged ${Buffer.byteLength(standalone)} bytes: ${output.pathname}`);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const css = readFileSync(join(ROOT, 'assets/css/forge.css'), 'utf8');
const shell = readFileSync(join(ROOT, 'src/forge-shell.js'), 'utf8');

test('the launcher keeps fixed controls outside its one bounded scrollport', () => {
  const launcherStart = html.indexOf('<dialog class="sheet forge-launcher"');
  const launcherEnd = html.indexOf('</dialog>', launcherStart);
  const fragment = html.slice(launcherStart, launcherEnd);
  const orderedIds = [
    'forge-launcher-form',
    'forge-result-summary',
    'forge-tool-list',
    'forge-tool-scroll-cue',
  ];
  let cursor = -1;
  for (const id of orderedIds) {
    const next = fragment.indexOf(`id="${id}"`);
    assert.ok(next > cursor, `${id} must stay in launcher reading order`);
    cursor = next;
  }
  assert.match(fragment, /class="forge-tool-scroll"[\s\S]*id="forge-tool-list"[\s\S]*id="forge-tool-scroll-cue"/);
});

test('desktop launcher height is dynamic and its chrome cannot be flex-shrunk', () => {
  assert.match(css, /#tool-launcher\.sheet\s*\{[\s\S]*?height:\s*min\(84dvh,\s*780px\);[\s\S]*?max-height:\s*calc\(100dvh\s*-\s*2rem\);[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.forge-launcher-head,[\s\S]*?\.forge-launcher-search,[\s\S]*?\.forge-filter-row,[\s\S]*?\.forge-result-summary\s*\{[\s\S]*?flex:\s*0\s+0\s+auto;/);
});

test('the result list owns scrolling and exposes a persistent affordance', () => {
  assert.match(css, /\.forge-tool-scroll\s*\{[\s\S]*?flex:\s*1\s+1\s+0;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.forge-tool-list\s*\{[\s\S]*?flex:\s*1\s+1\s+0;[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;[\s\S]*?scrollbar-gutter:\s*stable;/);
  assert.match(css, /\.forge-tool-scroll-cue\s*\{[\s\S]*?flex:\s*0\s+0\s+auto;[\s\S]*?pointer-events:\s*none;/);
  assert.match(shell, /toolList\.scrollHeight\s*>\s*toolList\.clientHeight\s*\+\s*1/);
  assert.match(shell, /toolScrollCue\.hidden\s*=\s*!scrollable\s*\|\|\s*atEnd/);
  assert.match(shell, /toolList\.addEventListener\('scroll',\s*updateToolScrollCue/);
});

test('mobile launcher remains viewport-bound with the same internal scrollport', () => {
  assert.match(css, /#tool-launcher\.sheet\s*\{[\s\S]*?height:\s*100dvh;[\s\S]*?max-height:\s*100dvh;/);
  assert.match(css, /\.forge-launcher\s*\{[\s\S]*?height:\s*100dvh;[\s\S]*?max-height:\s*100dvh;/);
});

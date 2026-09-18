#!/usr/bin/env node
/* Regenerates docs/hero.gif, poster.png, social.png.
   npm install --prefix /tmp/beam-rec puppeteer-core
   node docs/record-hero.mjs */
import { createRequire } from 'module';
import { mkdirSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const puppeteer = createRequire('/tmp/beam-rec/package.json')('puppeteer-core');

const dir = path.dirname(fileURLToPath(import.meta.url));
const frames = '/tmp/beam-hero-frames';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fps = 12;
const duration = 7.0;
const n = Math.round(duration * fps);

rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--hide-scrollbars', '--allow-file-access-from-files']
});
const page = await browser.newPage();
await page.setViewport({ width: 920, height: 540, deviceScaleFactor: 2 });
await page.goto('file://' + path.join(dir, 'hero.html'), { waitUntil: 'load' });
await page.evaluate(() => { window.BEAM_RECORD = true; });

for (let i = 0; i < n; i++) {
  await page.evaluate((t) => window.seek(t), i / fps);
  await page.screenshot({ path: path.join(frames, String(i).padStart(4, '0') + '.png') });
}

await page.evaluate((t) => window.seek(t), 5.1);
await page.screenshot({ path: path.join(dir, 'poster.png') });
await browser.close();

const gif = path.join(dir, 'hero.gif');
execSync(
  `ffmpeg -y -framerate ${fps} -i ${frames}/%04d.png ` +
  `-vf "fps=${fps},scale=920:-1:flags=lanczos,split[s0][s1];` +
  `[s0]palettegen=max_colors=56:reserve_transparent=0:stats_mode=full[p];` +
  `[s1][p]paletteuse=dither=none" ${gif}`,
  { stdio: 'inherit' }
);
execSync(
  `ffmpeg -y -i ${path.join(dir, 'poster.png')} ` +
  `-vf "scale=1280:640:force_original_aspect_ratio=decrease,pad=1280:640:(ow-iw)/2:(oh-ih)/2:#080c12" ` +
  path.join(dir, 'social.png'),
  { stdio: 'inherit' }
);
console.log('wrote', gif);

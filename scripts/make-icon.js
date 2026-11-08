'use strict';

// 生成应用图标：build/icon.png（512×512）和 build/icon.ico（16～256 多尺寸）。
// 只在改图标时手动运行一次：node scripts/make-icon.js（需要能 require('playwright')）。

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUT = path.join(__dirname, '..', 'build');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eceef2"/>
    </linearGradient>
    <linearGradient id="gem" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4c7ff0"/><stop offset="1" stop-color="#9b72cb"/>
    </linearGradient>
  </defs>
  <rect x="10" y="10" width="236" height="236" rx="58" fill="url(#bg)" stroke="#d5d9e0" stroke-width="5"/>
  <circle cx="99" cy="104" r="55" fill="#d97757"/>
  <circle cx="157" cy="104" r="55" fill="url(#gem)" fill-opacity="0.9"/>
  <circle cx="128" cy="155" r="55" fill="#10a37f" fill-opacity="0.9"/>
</svg>`;

// ICO 文件：文件头 + 目录 + 每个尺寸一张 PNG
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  images.forEach(({ size, png }, i) => {
    const e = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e);
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt8(0, e + 2);
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((x) => x.png)]);
}

async function render(page, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${SVG.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  fs.writeFileSync(path.join(OUT, 'icon.png'), await render(page, 512));
  const images = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256]) images.push({ size, png: await render(page, size) });
  fs.writeFileSync(path.join(OUT, 'icon.ico'), buildIco(images));
  await browser.close();
  console.log('已生成 build/icon.png 和 build/icon.ico');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

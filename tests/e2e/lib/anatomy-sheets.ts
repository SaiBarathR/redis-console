import type { Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Labelled contact sheets of the 2x crops, one set per checkpoint (page or state), 24 tiles per sheet. Labels are
 * drawn as canvas text: page content is never parsed as HTML. No image dependencies.
 */
export async function contactSheets(page: Page, dir: string, title: string, crops: { label: string; file: string; checkpoint: string }[]): Promise<void> {
  const byCheckpoint = new Map<string, typeof crops>();
  for (const c of crops) byCheckpoint.set(c.checkpoint, [...(byCheckpoint.get(c.checkpoint) ?? []), c]);
  const sheet = await page.context().newPage();
  try {
    for (const [checkpoint, list] of byCheckpoint) {
      for (let start = 0, n = 0; start < list.length; start += 24, n++) {
        const images = list.slice(start, start + 24).map(c => ({ label: c.label, src: `data:image/png;base64,${readFileSync(path.join(dir, c.file)).toString('base64')}` }));
        const png = await sheet.evaluate(async ({ images, heading }) => {
          const cols = 4, w = 760, h = 340, top = 44;
          const canvas = document.createElement('canvas');
          canvas.width = cols * w;
          canvas.height = top + Math.ceil(images.length / cols) * h;
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#c8c8c8'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#000'; ctx.font = 'bold 24px monospace'; ctx.fillText(heading, 12, 30);
          for (const [i, crop] of images.entries()) {
            const x = (i % cols) * w, y = top + Math.floor(i / cols) * h;
            ctx.fillStyle = '#ededed'; ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
            ctx.fillStyle = '#111'; ctx.font = '15px monospace';
            const label = `${i}: ${crop.label}`;
            for (let line = 0; line < 2; line++) ctx.fillText(label.slice(line * 80, (line + 1) * 80), x + 10, y + 22 + line * 18, w - 20);
            const img = new Image(); img.src = crop.src; await img.decode();
            const scale = Math.min(1, (w - 20) / img.width, (h - 60) / img.height);
            ctx.drawImage(img, x + 10, y + 50, img.width * scale, img.height * scale);
          }
          return canvas.toDataURL('image/png').split(',')[1]!;
        }, { images, heading: `${title} / ${checkpoint}${list.length > 24 ? ` (${n + 1})` : ''}` });
        writeFileSync(path.join(dir, `sheet-${checkpoint}${n ? `-${n + 1}` : ''}.png`), Buffer.from(png, 'base64'));
      }
    }
  } finally { await sheet.close(); }
}

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

/**
 * Caption fonts, downloaded once from Google Fonts' GitHub repo. All are SIL Open Font License —
 * free to use in commercial videos. Anton is the tall condensed "viral caption" face, Montserrat
 * (variable, 100–900) covers the heavy karaoke style and clean subtitles.
 */
const SOURCES = {
  display: { file: 'Anton-Regular.ttf', url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf' },
  body: { file: 'Montserrat-Variable.ttf', url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf' },
  // Elegant italic serif for cinematic / aesthetic titles.
  serif: { file: 'PlayfairDisplay-Italic-Variable.ttf', url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/PlayfairDisplay-Italic%5Bwght%5D.ttf' },
};

let pending = null;

/** { display: path|null, body: path|null } — missing fonts fall back to system fonts in the render. */
export function ensureFonts(toolsDir) {
  pending ||= (async () => {
    const dir = path.join(toolsDir, 'fonts');
    const out = {};
    for (const [key, { file, url }] of Object.entries(SOURCES)) {
      const dest = path.join(dir, file);
      if (fsSync.existsSync(dest)) {
        out[key] = dest;
        continue;
      }
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(`${dest}.part`, Buffer.from(await r.arrayBuffer()));
        await fs.rename(`${dest}.part`, dest);
        out[key] = dest;
      } catch (err) {
        console.error(`  Caption font ${file} unavailable (${err.message}) — using system fonts.`);
        out[key] = null;
      }
    }
    if (!out.display || !out.body) pending = null; // retry on the next render
    return out;
  })();
  return pending;
}

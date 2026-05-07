import { Resvg, initWasm } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';

let inited = false;
let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (inited) return;
  // Guard against concurrent calls racing initWasm — it throws if called twice.
  if (!initPromise) {
    initPromise = initWasm(resvgWasm).then(() => { inited = true; });
  }
  await initPromise;
}

/**
 * Rasterise an SVG string to a PNG. The SVG is expected to already have its
 * intrinsic dimensions set (1200x630 for our share cards); we pass `fitTo`
 * with the requested width as a guard so non-conforming SVGs still come out
 * at the expected size.
 */
export async function svgToPng(svg: string, width: number, _height: number): Promise<Uint8Array> {
  await ensureInit();
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: false },
  });
  const pngData = resvg.render().asPng();
  return pngData;
}

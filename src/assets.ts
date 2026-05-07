// Inline base64-encoded logo data URIs used by the overlay's top-left brand
// block.
//
// Defaults are empty strings, which the overlay treats as "no logo — render
// nothing in that slot". To add your own:
//   1. Convert your PNG to a data URI (e.g. `printf 'data:image/png;base64,';
//      base64 -i logo.png` on macOS).
//   2. Paste the value into the relevant constant below.
//
// Keep these small: every byte is shipped on every overlay request.

export const BRAND_LOGO_DATA_URI = "";
export const BRAND_MASCOT_DATA_URI = "";

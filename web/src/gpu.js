// gpu.js — which graphics chip the browser is really drawing with.
//
// Does: reads the renderer name WebGL reports (WEBGL_debug_renderer_info)
// and sorts it into software (no graphics card at all: SwiftShader,
// llvmpipe, Microsoft Basic Render), integrated (the processor's built-in
// graphics) or dedicated (NVIDIA, AMD Radeon); gives the advice to show
// when the browser is not using the dedicated card.
// Does NOT: change any setting itself; the browser and the operating system
// decide which chip a page gets.

export function gpuInfo(renderer) {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const raw = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  // "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x...) Direct3D11 ...)" -> "NVIDIA GeForce RTX 3060"
  const m = raw.match(/ANGLE \([^,]*,\s*([^(,]+)/);
  const name = (m ? m[1] : raw).trim();
  let kind = 'unknown';
  if (/swiftshader|llvmpipe|software|basic render|softpipe/i.test(raw)) kind = 'software';
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon\s*(rx|pro)|radeon\(tm\) rx|arc a\d/i.test(raw)) kind = 'dedicated';
  else if (/intel|uhd|iris|radeon\(tm\) graphics|radeon graphics|vega \d|adreno|mali|powervr/i.test(raw)) kind = 'integrated';
  else if (/apple/i.test(raw)) kind = 'apple';
  return { name, raw, kind };
}

export function gpuAdvice(info) {
  if (info.kind === 'software') {
    return 'Your browser is drawing without the graphics card (software rendering), so the game is slow and coarse. ' +
      'In Chrome or Edge: Settings → System → turn on "Use graphics acceleration when available", then restart the browser.';
  }
  if (info.kind === 'integrated') {
    return `The browser is using the built-in graphics (${info.name}). If this computer has an NVIDIA or AMD card, ` +
      'open Windows Settings → System → Display → Graphics, pick your browser, choose "High performance", and restart the browser.';
  }
  return '';
}

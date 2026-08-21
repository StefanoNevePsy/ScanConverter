import test from 'node:test';
import assert from 'node:assert/strict';

test('il bridge registra le figure una alla volta e le riusa alle compilazioni successive', async () => {
  const prepared = [];
  const compiled = [];
  let ready = false;
  globalThis.window = {
    scanConverterDesktop: {
      isDesktop: true,
      capabilities: async () => ({ desktop: true, nativeTypst: true }),
      prepareTypstFigureSet: async (request) => {
        prepared.push(request);
        if (request.finalize) ready = true;
        return { ok: true, figureSetReady: Boolean(request.finalize) };
      },
      compileTypst: async (request) => {
        compiled.push(request);
        if (!ready) return { ok: false, code: 'UNKNOWN_FIGURE_SET' };
        return { ok: true, figureSetReady: true, artifact: { kind: 'desktop-pdf', id: 'pdf', url: 'app://pdf' } };
      },
    },
  };

  try {
    const desktop = await import(`../src/lib/desktop.js?test=${Date.now()}`);
    const figures = [
      { path: '/figures/1.png', bytes: new Uint8Array([1, 2]) },
      { path: '/figures/2.png', bytes: new Uint8Array([3, 4]) },
    ];
    await desktop.compileWithNativeTypst('= Uno', figures);
    await desktop.compileWithNativeTypst('= Due', figures);

    assert.equal(prepared.length, 4); // reset + due figure + finalize
    assert.equal(prepared.filter((request) => request.figure).length, 2);
    assert.ok(prepared.every((request) => !Array.isArray(request.figures)));
    assert.equal(compiled.length, 3); // cache probe + prima compilazione + seconda
    assert.ok(compiled.every((request) => !Object.hasOwn(request, 'figures')));
  } finally {
    delete globalThis.window;
  }
});

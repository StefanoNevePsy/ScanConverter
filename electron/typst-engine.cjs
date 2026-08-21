const { createTypstRunner } = require('./typst-runner.cjs');

let config;
try {
  config = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8'));
} catch (error) {
  process.stderr.write(`Configurazione motore Typst non valida: ${error.message}\n`);
  process.exit(1);
}

const runner = createTypstRunner(config);
let queue = Promise.resolve();

process.parentPort.on('message', (event) => {
  const request = event.data;
  queue = queue
    .catch(() => {})
    .then(async () => {
      try {
        const result = request.operation === 'prepareFigureSet'
          ? await runner.prepareFigureSet(request)
          : await runner.compile(request);
        process.parentPort.postMessage({ id: request.id, ...result });
      } catch (error) {
        process.parentPort.postMessage({
          id: request.id,
          ok: false,
          infrastructure: true,
          diagnostics: [],
          error: error?.message || String(error),
        });
      }
    });
});

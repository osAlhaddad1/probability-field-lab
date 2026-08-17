import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(projectRoot, 'src');
const outputRoot = join(projectRoot, 'out');
const requestedPort = Number(process.env.PORT || 8080);

async function findAvailablePort(startPort) {
  for (let candidate = startPort; candidate < startPort + 50; candidate++) {
    const available = await new Promise(resolve => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(candidate, '127.0.0.1');
    });
    if (available) return candidate;
  }
  throw new Error(`No available port found between ${startPort} and ${startPort + 49}.`);
}

const port = await findAvailablePort(requestedPort);

function findJavaSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findJavaSources(path);
    return extname(entry.name) === '.java' ? [path] : [];
  });
}

mkdirSync(outputRoot, { recursive: true });

console.log('\n  Probability Field Lab');
console.log('  Compiling Java backend…\n');

const compilation = spawnSync(
  'javac',
  ['-encoding', 'UTF-8', '-d', outputRoot, ...findJavaSources(sourceRoot)],
  { cwd: projectRoot, stdio: 'inherit', shell: false }
);

if (compilation.error) {
  console.error(`Could not start javac: ${compilation.error.message}`);
  process.exit(1);
}
if (compilation.status !== 0) process.exit(compilation.status ?? 1);

console.log('  ✓ Java backend compiled');
if (port !== requestedPort) console.log(`  ℹ Port ${requestedPort} is busy; using ${port} instead`);
console.log(`  ✓ Frontend + API: http://localhost:${port}`);
console.log('  Press Ctrl+C to stop\n');

const server = spawn(
  'java',
  [
    `-Dexperiment.root=${projectRoot}`,
    `-Dexperiment.port=${port}`,
    '-cp',
    outputRoot,
    'probexperiment.Main'
  ],
  { cwd: projectRoot, stdio: 'inherit', shell: false }
);

server.on('error', error => {
  console.error(`Could not start Java: ${error.message}`);
  process.exit(1);
});

server.on('exit', code => process.exit(code ?? 0));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.kill(signal);
  });
}

import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(projectRoot, 'src');
const frontendRoot = join(projectRoot, 'frontend');
const buildRoot = resolve(projectRoot, 'build');
const classesRoot = join(buildRoot, 'classes');
const artifact = join(buildRoot, 'probability-field-lab.jar');

function findJavaSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findJavaSources(path);
    return extname(entry.name) === '.java' ? [path] : [];
  });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function createJar(args) {
  const result = spawnSync('jar', args, { cwd: projectRoot, stdio: 'inherit', shell: false });
  if (result.error?.code === 'ENOENT') {
    run('java', ['-m', 'jdk.jartool/sun.tools.jar.Main', ...args]);
    return;
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync(buildRoot, { recursive: true, force: true });
mkdirSync(classesRoot, { recursive: true });

console.log('Compiling Java 21 application...');
run('javac', ['--release', '21', '-encoding', 'UTF-8', '-d', classesRoot, ...findJavaSources(sourceRoot)]);

console.log('Embedding the frontend...');
cpSync(frontendRoot, join(classesRoot, 'frontend'), { recursive: true });

console.log('Creating executable JAR...');
createJar(['--create', '--file', artifact, '--main-class', 'probexperiment.Main', '-C', classesRoot, '.']);

console.log(`Built ${artifact}`);

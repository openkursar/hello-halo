import { build } from 'esbuild';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { bundledLicenseNotice } from './bundled-licenses.mjs';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));

// Tests can build an isolated execution artifact without touching a developer's dist directory.
export async function buildWorker(outfile = fileURLToPath(new URL('../dist/worker/entry.js', import.meta.url))) {
  const result = await build({
    absWorkingDir: projectDirectory,
    entryPoints: [fileURLToPath(new URL('../worker/entry.ts', import.meta.url))],
    outfile: resolve(outfile),
    bundle: true, platform: 'node', format: 'esm', target: 'node20', sourcemap: true,
    metafile: true, write: false,
    banner: { js: "/*! Third-party licenses: ./THIRD-PARTY-NOTICES.txt */\nimport { createRequire as workerCreateRequire } from 'node:module'; const require = workerCreateRequire(import.meta.url);" },
  });
  const notices = await bundledLicenseNotice(result.metafile, projectDirectory, projectDirectory);
  const outputDirectory = dirname(resolve(outfile));
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    ...result.outputFiles.map(file => writeFile(file.path, file.contents)),
    writeFile(join(outputDirectory, 'THIRD-PARTY-NOTICES.txt'), notices),
  ]);
  return result;
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  await buildWorker();
}

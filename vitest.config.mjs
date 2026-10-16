import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const workspacePackages = [
  'browser',
  'core',
  'shared',
  'utils',
  'vue',
  'react',
  'types',
  'web',
];

function packageAliases() {
  const aliases = [];
  for (const pkg of workspacePackages) {
    const pkgRoot = path.resolve(__dirname, `packages/${pkg}/src`);
    const moduleName = `encode-yt-monitor-${pkg}`;
    aliases.push({
      find: new RegExp(`^${moduleName}$`),
      replacement: path.join(pkgRoot, 'index.ts'),
    });
    aliases.push({
      find: new RegExp(`^${moduleName}/(.+)$`),
      replacement: `${pkgRoot}/$1.ts`,
    });
  }
  return aliases;
}

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: packageAliases(),
  },
});

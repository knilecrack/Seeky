const esbuild = require('esbuild');
const watch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode', '@ff-labs/fff-node'],
  format: 'cjs',
  platform: 'node',
  sourcemap: true,
  minify: !watch,
};

if (watch) {
  esbuild.context(buildOptions).then(ctx => {
    ctx.watch();
    console.log('Watching for changes...');
  });
} else {
  esbuild.build(buildOptions).catch(() => process.exit(1));
}

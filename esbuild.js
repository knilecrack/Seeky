const esbuild = require('esbuild');
const { execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const watch = process.argv.includes('--watch');

const twCmd = `npx @tailwindcss/cli -i media/input.css -o media/style.css`;

function copyCodeicons() {
  const src = 'node_modules/@vscode/codicons/dist';
  fs.copyFileSync(`${src}/codicon.css`, 'media/codicon.css');
  fs.copyFileSync(`${src}/codicon.ttf`, 'media/codicon.ttf');
}

function copyFonts() {
  const variants = ['argon', 'krypton', 'neon', 'radon', 'xenon'];
  variants.forEach(v => {
    const src = `node_modules/@fontsource/monaspace-${v}/files`;
    fs.copyFileSync(`${src}/monaspace-${v}-latin-400-normal.woff2`, `media/monaspace-${v}.woff2`);
  });
}

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
  copyCodeicons();
  copyFonts();
  spawn('npx', ['@tailwindcss/cli', '-i', 'media/input.css', '-o', 'media/style.css', '--watch'], { stdio: 'inherit', shell: true });
  esbuild.context(buildOptions).then(ctx => {
    ctx.watch();
    console.log('Watching for changes...');
  });
} else {
  copyCodeicons();
  copyFonts();
  execSync(`${twCmd} --minify`, { stdio: 'inherit' });
  esbuild.build(buildOptions).catch(() => process.exit(1));
}

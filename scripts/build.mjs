// Bundles the extension host code and the merge webview (Monaco + UI).
// Usage: node scripts/build.mjs [--watch] [--dev]
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

const common = {
    bundle: true,
    minify: !dev,
    sourcemap: dev,
    logLevel: 'info',
};

const builds = [
    {
        ...common,
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
        external: ['vscode'],
        format: 'cjs',
        platform: 'node',
        target: 'node18',
    },
    {
        ...common,
        entryPoints: { main: 'src/webview/main.ts', 'editor.worker': 'src/webview/editor.worker.ts' },
        outdir: 'dist/webview',
        format: 'iife',
        platform: 'browser',
        target: 'chrome120',
        loader: { '.ttf': 'dataurl' },
        // Monaco ships optional language services we do not bundle; keep its diagnostics out of the build log.
        logOverride: { 'unsupported-css-nesting': 'silent', 'css-syntax-error': 'silent' },
    },
];

if (watch) {
    for (const options of builds) {
        await (await esbuild.context(options)).watch();
    }
} else {
    await Promise.all(builds.map(options => esbuild.build(options)));
}

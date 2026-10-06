/**
 * Runs the end-to-end suite in a real VS Code Extension Host, against a temporary conflicted repository.
 * Usage: npm run test:e2e   (set VSCODE_EXECUTABLE to override the VS Code binary)
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createConflictRepo } from '../helpers';

const BASE = [
    'import { a } from "./a";',
    '',
    'export function hello() {',
    '    return "hello";',
    '}',
    '',
    'export const VERSION = 1;',
    '',
    'export function greet(suffix: string) {',
    '    const greeting = "Hello, World" + suffix;',
    '    return greeting;',
    '}',
].join('\n') + '\n';

const OURS = BASE
    .replace('import { a } from "./a";\n', 'import { a } from "./a";\nimport { log } from "./log";\n')
    .replace('return "hello";', 'return "hello from main";')
    .replace('"Hello, World"', '"Hello, World!!"');

const THEIRS = BASE
    .replace('return "hello";', 'return "hello from feature";')
    .replace('VERSION = 1', 'VERSION = 2')
    .replace('+ suffix;', '+ suffix.trim();');

function defaultExecutable(): string {
    switch (process.platform) {
        case 'darwin': return '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
        case 'win32': return path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
        default: return '/usr/share/code/code';
    }
}

async function main(): Promise<void> {
    const extensionRoot = path.resolve(__dirname, '..', '..', '..');
    const repo = createConflictRepo({
        'app.ts': { base: BASE, ours: OURS, theirs: THEIRS },
        'notes.txt': { base: 'shared\nline\n', ours: 'shared\nline ours\n', theirs: 'shared\nline theirs\n' },
    });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-resolver-e2e-'));
    const report = path.join(scratch, 'report.txt');
    const env: NodeJS.ProcessEnv = { ...process.env, E2E_REPORT: report };
    delete env.ELECTRON_RUN_AS_NODE;

    const code = await new Promise<number>(resolve => {
        const child = spawn(process.env.VSCODE_EXECUTABLE ?? defaultExecutable(), [
            repo,
            `--extensionDevelopmentPath=${extensionRoot}`,
            `--extensionTestsPath=${path.join(__dirname, 'suite.js')}`,
            `--user-data-dir=${path.join(scratch, 'user-data')}`,
            `--extensions-dir=${path.join(scratch, 'extensions')}`,
            '--disable-workspace-trust',
            '--skip-welcome',
            '--skip-release-notes',
            '--new-window',
        ], { env, stdio: 'ignore' });
        child.on('exit', status => resolve(status ?? 1));
    });

    console.log(fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '(no report written)');
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exitCode = code;
    console.log(code === 0 ? 'E2E PASSED' : `E2E FAILED (exit ${code})`);
}

void main();

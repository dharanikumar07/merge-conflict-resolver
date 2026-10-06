import type { HostMessage, WebviewMessage } from '../shared/protocol';
import { MergeView } from './MergeView';
import * as monaco from './monaco';
import './styles.css';
import { applyVsCodeTheme, onThemeChange } from './theme';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const post = (message: WebviewMessage) => vscode.postMessage(message);

// Webviews cannot start workers from extension resource URLs directly; load the script into a blob instead.
let workerSource: Promise<string> | undefined;
(globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    async getWorker(): Promise<Worker> {
        workerSource ??= fetch(document.body.dataset.workerUrl!).then(r => r.text());
        const url = URL.createObjectURL(new Blob([await workerSource], { type: 'text/javascript' }));
        return new Worker(url);
    },
};

let view: MergeView | undefined;

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
    const message = event.data;
    try {
        if (message.type === 'init') {
            view?.dispose();
            applyVsCodeTheme();
            view = new MergeView(document.getElementById('app')!, message.data, post);
        } else {
            view?.handle(message);
        }
    } catch (error) {
        post({ type: 'info', message: `Merge view error: ${(error as Error).message}` });
    }
});

onThemeChange(() => {
    applyVsCodeTheme();
    view?.refreshTheme();
});

// Re-measure once the editor font is available so line heights and columns are exact.
void document.fonts.ready.then(() => {
    monaco.editor.remeasureFonts();
    view?.render();
});

post({ type: 'ready' });

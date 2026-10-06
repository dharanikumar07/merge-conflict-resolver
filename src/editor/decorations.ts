import * as vscode from 'vscode';

export type HighlightStyle = 'conflict' | 'added' | 'deleted' | 'modified' | 'resolved';

export interface Highlight {
    style: HighlightStyle;
    /** Line range [startLine, endLine). An empty range is drawn as a thin marker between lines. */
    startLine: number;
    endLine: number;
}

const STYLES: HighlightStyle[] = ['conflict', 'added', 'deleted', 'modified', 'resolved'];

// Backgrounds are contributed colors (see package.json) whose defaults point at existing theme colors, so they adapt
// to every theme and can be overridden in `workbench.colorCustomizations`. Borders/rulers use theme colors directly.
const BACKGROUND: Record<HighlightStyle, string | undefined> = {
    conflict: 'phpstormMerge.conflictBackground',
    added: 'phpstormMerge.addedBackground',
    deleted: 'phpstormMerge.deletedBackground',
    modified: 'phpstormMerge.modifiedBackground',
    resolved: undefined,
};

const ACCENT: Record<HighlightStyle, string> = {
    conflict: 'editorError.foreground',
    added: 'editorOverviewRuler.addedForeground',
    deleted: 'editorOverviewRuler.deletedForeground',
    modified: 'editorOverviewRuler.modifiedForeground',
    resolved: 'editorLineNumber.foreground',
};

/** Decoration types shared by all merge editors (created once per extension activation). */
export class MergeDecorations implements vscode.Disposable {
    private readonly blockTypes = new Map<HighlightStyle, vscode.TextEditorDecorationType>();
    private readonly markerTypes = new Map<HighlightStyle, vscode.TextEditorDecorationType>();

    constructor() {
        for (const style of STYLES) {
            const accent = new vscode.ThemeColor(ACCENT[style]);
            const background = BACKGROUND[style];
            const ruler = style === 'resolved' ? {} : { overviewRulerColor: accent, overviewRulerLane: vscode.OverviewRulerLane.Full };
            this.blockTypes.set(style, vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                backgroundColor: background ? new vscode.ThemeColor(background) : undefined,
                borderColor: accent,
                borderStyle: 'solid',
                borderWidth: style === 'resolved' ? '0 0 0 1px' : '0 0 0 3px',
                ...ruler,
            }));
            this.markerTypes.set(style, vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                borderColor: accent,
                borderStyle: 'solid',
                borderWidth: style === 'resolved' ? '1px 0 0 0' : '2px 0 0 0',
                ...ruler,
            }));
        }
    }

    apply(editor: vscode.TextEditor, highlights: readonly Highlight[]): void {
        const blocks = new Map<HighlightStyle, vscode.Range[]>(STYLES.map(s => [s, []]));
        const markers = new Map<HighlightStyle, vscode.Range[]>(STYLES.map(s => [s, []]));
        const lastLine = editor.document.lineCount - 1;
        for (const h of highlights) {
            if (h.endLine > h.startLine) {
                blocks.get(h.style)!.push(new vscode.Range(h.startLine, 0, Math.min(h.endLine - 1, lastLine), 0));
            } else {
                const line = Math.min(h.startLine, lastLine);
                markers.get(h.style)!.push(new vscode.Range(line, 0, line, 0));
            }
        }
        for (const style of STYLES) {
            editor.setDecorations(this.blockTypes.get(style)!, blocks.get(style)!);
            editor.setDecorations(this.markerTypes.get(style)!, markers.get(style)!);
        }
    }

    dispose(): void {
        [...this.blockTypes.values(), ...this.markerTypes.values()].forEach(t => t.dispose());
    }
}

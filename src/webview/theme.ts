import * as monaco from './monaco';

export const THEME_NAME = 'vscode-merge';

/** Workbench colors (exposed to webviews as `--vscode-*` CSS variables) that Monaco should use as well. */
const EDITOR_COLORS = [
    'editor.background', 'editor.foreground', 'editorLineNumber.foreground', 'editorLineNumber.activeForeground',
    'editorCursor.foreground', 'editor.selectionBackground', 'editor.inactiveSelectionBackground',
    'editor.selectionHighlightBackground', 'editor.lineHighlightBackground', 'editor.lineHighlightBorder',
    'editor.findMatchBackground', 'editor.findMatchHighlightBackground', 'editor.wordHighlightBackground',
    'editorWhitespace.foreground', 'editorIndentGuide.background1', 'editorIndentGuide.activeBackground1',
    'editorBracketMatch.background', 'editorBracketMatch.border', 'editorGutter.background',
    'editorWidget.background', 'editorWidget.foreground', 'editorWidget.border', 'editorHoverWidget.background',
    'editorHoverWidget.border', 'editorSuggestWidget.background', 'editorSuggestWidget.border',
    'editorSuggestWidget.foreground', 'editorSuggestWidget.selectedBackground', 'input.background',
    'input.foreground', 'input.border', 'inputOption.activeBorder', 'focusBorder', 'scrollbar.shadow',
    'scrollbarSlider.background', 'scrollbarSlider.hoverBackground', 'scrollbarSlider.activeBackground',
    'editorOverviewRuler.border', 'list.hoverBackground', 'list.activeSelectionBackground',
    'list.activeSelectionForeground', 'menu.background', 'menu.foreground', 'menu.selectionBackground',
    'menu.selectionForeground', 'menu.separatorBackground', 'widget.shadow',
];

/** Defines and activates a Monaco theme that matches the current VS Code color theme. */
export function applyVsCodeTheme(): void {
    const style = getComputedStyle(document.documentElement);
    const colors: Record<string, string> = {};
    for (const id of EDITOR_COLORS) {
        const value = toHex(style.getPropertyValue(`--vscode-${id.replace(/\./g, '-')}`).trim());
        if (value) {
            colors[id] = value;
        }
    }
    monaco.editor.defineTheme(THEME_NAME, { base: themeKind(), inherit: true, rules: [], colors });
    monaco.editor.setTheme(THEME_NAME);
}

export function onThemeChange(listener: () => void): void {
    new MutationObserver(listener).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

/** Editor font settings, so the panes look like ordinary VS Code editors. */
export function editorFont(): { fontFamily?: string; fontSize?: number; fontWeight?: string } {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string) => style.getPropertyValue(`--vscode-editor-${name}`).trim() || undefined;
    const size = parseFloat(read('font-size') ?? '');
    return { fontFamily: read('font-family'), fontSize: Number.isFinite(size) ? size : undefined, fontWeight: read('font-weight') };
}

function themeKind(): monaco.editor.BuiltinTheme {
    const classes = document.body.classList;
    if (classes.contains('vscode-high-contrast-light')) {
        return 'hc-light';
    }
    if (classes.contains('vscode-high-contrast')) {
        return 'hc-black';
    }
    return classes.contains('vscode-light') ? 'vs' : 'vs-dark';
}

/** Monaco only accepts hex colors; VS Code may hand out `rgba(...)`. */
function toHex(value: string): string | undefined {
    if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
        return value;
    }
    const match = /^rgba?\(([^)]+)\)$/i.exec(value);
    if (!match) {
        return undefined;
    }
    const [r, g, b, a = '1'] = match[1].split(/[\s,/]+/).filter(Boolean);
    const hex = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
    const alpha = a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a);
    return `#${hex(+r)}${hex(+g)}${hex(+b)}${alpha < 1 ? hex(alpha * 255) : ''}`;
}

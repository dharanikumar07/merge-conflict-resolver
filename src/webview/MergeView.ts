import type { MergeChunk, Side } from '../merge/MergeChunk';
import { ApplyFilter, MergeModel, ResultEdit } from '../merge/MergeModel';
import type { ActionReply, ComparisonId, HostMessage, InitData, MergeAction, ViewState, WebviewMessage } from '../shared/protocol';
import { ChangeStyle, ChunkAction, Divider, DividerSource, LineRange, Pane } from './Divider';
import { ICONS } from './icons';
import * as monaco from './monaco';
import { editorFont, THEME_NAME } from './theme';
import { wordDiff } from './words';

const PANES: readonly Pane[] = ['ours', 'result', 'theirs'];
const SIDES: readonly Side[] = ['ours', 'theirs'];
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
const STATE_DELAY_MS = 40;
const MIN_PANE_WIDTH = 120;

type Decoration = monaco.editor.IModelDeltaDecoration;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The MergeFlow merge editor: Yours (read-only) | Result (editable) | Theirs (read-only), with clickable
 * accept/ignore arrows in the dividers. Owns the MergeModel; the extension host only reads its state.
 */
export class MergeView implements DividerSource {
    private readonly model: MergeModel;
    private readonly editors: Record<Pane, monaco.editor.IStandaloneCodeEditor>;
    private readonly decorations: Record<Pane, monaco.editor.IEditorDecorationsCollection>;
    private readonly dividers: Divider[];
    private readonly statusEl: HTMLElement;
    private readonly disposables: monaco.IDisposable[] = [];
    private readonly initialVersion: number;
    private currentChunkId: number | undefined;
    private lastFocused: Pane = 'result';
    private highlightWords = true;
    private syncing = false;
    private renderQueued = false;
    private stateTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly root: HTMLElement, private readonly data: InitData, private readonly post: (message: WebviewMessage) => void) {
        this.model = MergeModel.create(data.base, data.ours, data.theirs, data.eol);
        root.innerHTML = layout(data);
        this.statusEl = root.querySelector('#status')!;

        const language = resolveLanguage(data.languageId, data.fileName);
        const createModel = (pane: Pane, text: string) => {
            const model = monaco.editor.createModel(text, language, monaco.Uri.from({ scheme: 'merge', authority: pane, path: `/${data.fileName}` }));
            model.setEOL(data.eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
            return model;
        };
        const options: monaco.editor.IStandaloneEditorConstructionOptions = {
            ...editorFont(),
            theme: THEME_NAME,
            automaticLayout: true,
            minimap: { enabled: false },
            wordWrap: 'off',
            stickyScroll: { enabled: false },
            smoothScrolling: false,
            folding: false,
            glyphMargin: false,
            lineDecorationsWidth: 8,
            scrollBeyondLastLine: true,
            fixedOverflowWidgets: true,
            renderLineHighlight: 'line',
            overviewRulerBorder: false,
            hideCursorInOverviewRuler: true,
            scrollbar: { useShadows: false, verticalScrollbarSize: 12, horizontalScrollbarSize: 12, alwaysConsumeMouseWheel: true },
        };
        const side = (pane: Side, text: string, extra: monaco.editor.IStandaloneEditorConstructionOptions) =>
            monaco.editor.create(root.querySelector(`#ed-${pane}`)!, {
                ...options, ...extra, model: createModel(pane, text), readOnly: true, lineNumbers: 'off',
                renderLineHighlight: 'none', occurrencesHighlight: 'off', selectionHighlight: false,
            });
        this.editors = {
            // The line numbers of the side panes are drawn in the dividers, next to the Result.
            ours: side('ours', this.model.ours, { overviewRulerLanes: 0, scrollbar: { ...options.scrollbar, vertical: 'hidden', verticalScrollbarSize: 0 } }),
            result: monaco.editor.create(root.querySelector('#ed-result')!, { ...options, model: createModel('result', this.model.initialResult), glyphMargin: true, lineNumbers: 'on' }),
            theirs: side('theirs', this.model.theirs, {}),
        };
        this.decorations = {
            ours: this.editors.ours.createDecorationsCollection(),
            result: this.editors.result.createDecorationsCollection(),
            theirs: this.editors.theirs.createDecorationsCollection(),
        };
        this.initialVersion = this.resultModel.getAlternativeVersionId();
        if (this.resultModel.getValue() !== this.model.initialResult) {
            this.post({ type: 'info', message: 'The Result could not be initialized exactly (unexpected line endings). Review it carefully.' });
        }
        this.dividers = [
            new Divider(root.querySelector('#dv-ours')!, 'ours', this),
            new Divider(root.querySelector('#dv-theirs')!, 'theirs', this),
        ];

        this.wireEditors();
        this.wireToolbar();
        this.wireSplitters();
        if (data.autoApplyNonConflicting) {
            this.applyEdits(this.model.applyNonConflicting('all'));
        }
        // Wait for the first layout so scroll positions and line heights are known.
        requestAnimationFrame(() => {
            const first = this.model.conflicts[0] ?? this.model.chunks[0];
            if (first) {
                this.reveal(first);
            }
            this.render();
            this.editors.result.focus();
        });
        this.render();
        this.postState();
    }

    // ---- DividerSource ----

    editor(pane: Pane): monaco.editor.IStandaloneCodeEditor {
        return this.editors[pane];
    }

    chunks(): readonly MergeChunk[] {
        return this.model.chunks;
    }

    lines(chunk: MergeChunk, pane: Pane): LineRange {
        if (pane !== 'result') {
            return chunk.sideLines(pane);
        }
        const model = this.resultModel;
        const start = model.getPositionAt(chunk.start);
        if (chunk.end === chunk.start) {
            // An insertion point at the very end of a file without a trailing newline sits after the last line.
            return start.column > 1 ? { start: start.lineNumber, end: start.lineNumber } : { start: start.lineNumber - 1, end: start.lineNumber - 1 };
        }
        const end = model.getPositionAt(chunk.end);
        return { start: start.lineNumber - 1, end: end.column > 1 ? end.lineNumber : end.lineNumber - 1 };
    }

    sideStyle(chunk: MergeChunk, side: Side): ChangeStyle | undefined {
        if (chunk.state(side) !== 'pending' || chunk.edited) {
            return undefined;
        }
        return chunk.isConflict ? 'conflict' : shapeStyle(chunk, side);
    }

    appends(chunk: MergeChunk, side: Side): boolean {
        return chunk.isConflict && chunk.state(side === 'ours' ? 'theirs' : 'ours') === 'applied';
    }

    shortcut(side: Side): string {
        const arrow = side === 'ours' ? '→' : '←';
        return IS_MAC ? `⌃⌘${arrow}` : `Ctrl+Alt+${arrow}`;
    }

    act(side: Side, chunkId: number, action: ChunkAction): void {
        const chunk = this.model.chunk(chunkId);
        if (!chunk) {
            return;
        }
        this.currentChunkId = chunk.id;
        if (action === 'accept') {
            this.applyEdits([this.model.accept(chunk, side)]);
        } else {
            this.model.ignore(chunk, side, this.regionText(chunk));
        }
        this.changed();
    }

    // ---- Host messages ----

    handle(message: HostMessage): void {
        if (message.type !== 'action') {
            return;
        }
        let error: string | undefined;
        try {
            error = this.perform(message.action, message.chunkId, message.line);
        } catch (e) {
            error = (e as Error).message;
        }
        if (error && message.requestId === undefined) {
            this.post({ type: 'info', message: error });
        }
        if (message.requestId !== undefined) {
            this.post({ type: 'reply', requestId: message.requestId, reply: this.reply(error) });
        }
    }

    /** Runs an action; returns a user-facing message when it could not be performed. */
    private perform(action: MergeAction, chunkId?: number, line?: number): string | undefined {
        const nonConflicting: Partial<Record<MergeAction, ApplyFilter>> = {
            applyNonConflicting: 'all', applyNonConflictingYours: 'ours', applyNonConflictingTheirs: 'theirs',
        };
        switch (action) {
            case 'sync':
                return undefined;
            case 'nextConflict':
            case 'previousConflict':
                return this.navigate(action === 'nextConflict' ? 1 : -1);
            case 'revealLine':
                this.revealResultLine(line ?? 0);
                return undefined;
            case 'resolveAllSimple': {
                const edits = this.model.conflicts.filter(c => !c.resolved && c.oursState === 'pending' && c.theirsState === 'pending')
                    .map(c => this.model.resolveSimple(c));
                this.applyEdits(edits);
                this.changed();
                return edits.some(Boolean) ? undefined : 'No simple conflicts to resolve: the remaining conflicts change the same text on both sides.';
            }
            case 'applyNonConflicting':
            case 'applyNonConflictingYours':
            case 'applyNonConflictingTheirs': {
                const edits = this.model.applyNonConflicting(nonConflicting[action]!);
                this.applyEdits(edits);
                this.changed();
                return edits.length > 0 ? undefined : 'No pending non-conflicting changes.';
            }
        }

        const chunk = this.targetChunk(chunkId);
        if (!chunk) {
            return 'Place the cursor inside a change or conflict first.';
        }
        this.currentChunkId = chunk.id;
        switch (action) {
            case 'acceptYours':
            case 'acceptTheirs':
                this.applyEdits([this.model.accept(chunk, action === 'acceptYours' ? 'ours' : 'theirs')]);
                break;
            case 'ignoreYours':
            case 'ignoreTheirs':
                this.model.ignore(chunk, action === 'ignoreYours' ? 'ours' : 'theirs', this.regionText(chunk));
                break;
            case 'acceptBoth':
                this.applyEdits([this.model.acceptBoth(chunk)]);
                break;
            case 'resolveSimple': {
                const edit = this.model.resolveSimple(chunk);
                if (!edit) {
                    return 'This conflict cannot be resolved automatically: both sides changed the same text.';
                }
                this.applyEdits([edit]);
                break;
            }
            case 'revertResolution':
                this.applyEdits([this.model.revert(chunk)]);
                break;
        }
        this.changed();
        return undefined;
    }

    private reply(error?: string): ActionReply {
        return {
            state: this.state(),
            result: this.resultModel.getValue(),
            chunks: this.model.chunks.map(c => ({ id: c.id, kind: c.kind, ours: c.oursState, theirs: c.theirsState, resolved: c.resolved })),
            error,
        };
    }

    // ---- Editing ----

    private get resultModel(): monaco.editor.ITextModel {
        return this.editors.result.getModel()!;
    }

    private regionText(chunk: MergeChunk): string {
        const model = this.resultModel;
        return model.getValueInRange(monaco.Range.fromPositions(model.getPositionAt(chunk.start), model.getPositionAt(chunk.end)));
    }

    /** Applies model edits to the Result as one undoable step. */
    private applyEdits(edits: readonly (ResultEdit | undefined)[]): void {
        const model = this.resultModel;
        const operations = edits.filter((e): e is ResultEdit => e !== undefined).map(e => ({
            range: monaco.Range.fromPositions(model.getPositionAt(e.start), model.getPositionAt(e.end)),
            text: e.text,
            forceMoveMarkers: true,
        }));
        if (operations.length === 0) {
            return;
        }
        const editor = this.editors.result;
        editor.pushUndoStop();
        editor.executeEdits('merge', operations);
        editor.pushUndoStop();
    }

    // ---- Navigation and scrolling ----

    private chunkAt(pane: Pane, line: number): MergeChunk | undefined {
        if (pane !== 'result') {
            return this.model.chunkAtLine(pane, line);
        }
        const matches = this.model.chunks.filter(c => {
            const r = this.lines(c, 'result');
            return (r.start <= line && line < r.end) || (r.start === r.end && r.start === line);
        });
        return matches.find(c => c.end > c.start) ?? matches[0];
    }

    private targetChunk(chunkId?: number): MergeChunk | undefined {
        if (chunkId !== undefined) {
            return this.model.chunk(chunkId);
        }
        const position = this.editors[this.lastFocused].getPosition();
        return (position && this.chunkAt(this.lastFocused, position.lineNumber - 1))
            ?? (this.currentChunkId !== undefined ? this.model.chunk(this.currentChunkId) : undefined);
    }

    /** Next/previous unresolved conflict (or pending change once all conflicts are resolved), wrapping around. */
    private navigate(direction: 1 | -1): string | undefined {
        const conflicts = this.model.chunks.filter(c => c.isConflict && !c.resolved);
        const candidates = conflicts.length > 0 ? conflicts : this.model.chunks.filter(c => !c.resolved);
        if (candidates.length === 0) {
            return 'All changes have been processed.';
        }
        const pane = this.lastFocused;
        const line = (this.editors[pane].getPosition()?.lineNumber ?? 0) - 1;
        const startOf = (c: MergeChunk) => this.lines(c, pane).start;
        const target = direction === 1
            ? candidates.find(c => startOf(c) > line) ?? candidates[0]
            : [...candidates].reverse().find(c => startOf(c) < line) ?? candidates[candidates.length - 1];
        this.reveal(target);
        return undefined;
    }

    /** Puts the cursor at the chunk in every pane and scrolls the focused pane so the chunk is centered. */
    private reveal(chunk: MergeChunk): void {
        this.currentChunkId = chunk.id;
        for (const pane of PANES) {
            const line = this.lines(chunk, pane).start + 1;
            this.editors[pane].setPosition({ lineNumber: Math.min(line, this.editors[pane].getModel()!.getLineCount()), column: 1 });
        }
        const pane = this.lastFocused;
        const editor = this.editors[pane];
        const r = this.lines(chunk, pane);
        const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
        const middle = ((r.start + Math.max(r.end, r.start + 1)) / 2) * lineHeight;
        editor.setScrollTop(Math.max(0, middle - editor.getLayoutInfo().height / 2));
        this.syncFrom(pane);
        this.render();
        this.postState();
    }

    private revealResultLine(line: number): void {
        const editor = this.editors.result;
        editor.setPosition({ lineNumber: line + 1, column: 1 });
        editor.revealLineInCenter(line + 1);
        editor.focus();
    }

    /** Keeps the other panes aligned with `source`, mapping its middle line through the chunk boundaries. */
    private syncFrom(source: Pane): void {
        const editor = this.editors[source];
        const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
        const height = editor.getLayoutInfo().height;
        const atTop = editor.getScrollTop() <= 0;
        const middleLine = (editor.getScrollTop() + height / 2) / lineHeight;
        this.syncing = true;
        try {
            for (const pane of PANES) {
                if (pane === source) {
                    continue;
                }
                const target = this.editors[pane];
                const targetLineHeight = target.getOption(monaco.editor.EditorOption.lineHeight);
                const top = atTop ? 0 : this.mapLine(middleLine, source, pane) * targetLineHeight - target.getLayoutInfo().height / 2;
                if (Math.abs(target.getScrollTop() - top) >= 1) {
                    target.setScrollTop(Math.max(0, top));
                }
            }
        } finally {
            this.syncing = false;
        }
    }

    private mapLine(line: number, from: Pane, to: Pane): number {
        let fromPrev = 0;
        let toPrev = 0;
        for (const chunk of this.model.chunks) {
            const a = this.lines(chunk, from);
            const b = this.lines(chunk, to);
            if (line < a.start) {
                return toPrev + Math.min(line - fromPrev, b.start - toPrev);
            }
            if (line < a.end) {
                return b.start + (line - a.start) * (b.end - b.start) / (a.end - a.start);
            }
            fromPrev = a.end;
            toPrev = b.end;
        }
        return toPrev + (line - fromPrev);
    }

    // ---- Rendering ----

    private changed(): void {
        this.scheduleRender();
        this.schedulePostState();
    }

    private scheduleRender(): void {
        if (!this.renderQueued) {
            this.renderQueued = true;
            requestAnimationFrame(() => {
                this.renderQueued = false;
                this.render();
            });
        }
    }

    render(): void {
        this.renderDecorations();
        this.dividers.forEach(d => d.render());
        this.renderStatus();
    }

    private renderDecorations(): void {
        const lists: Record<Pane, Decoration[]> = { ours: [], result: [], theirs: [] };
        const ruler = rulerColors();
        for (const chunk of this.model.chunks) {
            const resultStyle = this.resultStyle(chunk);
            if (resultStyle) {
                block(lists.result, this.resultModel, this.lines(chunk, 'result'), resultStyle, ruler, true);
            }
            for (const side of SIDES) {
                const style = this.sideStyle(chunk, side);
                if (!style) {
                    continue;
                }
                block(lists[side], this.editors[side].getModel()!, this.lines(chunk, side), style, ruler, false);
                if (this.highlightWords) {
                    this.wordDecorations(chunk, side, style, resultStyle ?? style, lists);
                }
            }
            if (chunk.isConflict && !chunk.edited && chunk.oursState === 'pending' && chunk.theirsState === 'pending' && chunk.simpleResolution !== undefined) {
                const line = Math.min(this.lines(chunk, 'result').start + 1, this.resultModel.getLineCount());
                lists.result.push({
                    range: new monaco.Range(line, 1, line, 1),
                    options: { glyphMarginClassName: 'mg-wand', glyphMarginHoverMessage: { value: 'Resolve simple conflict: both sides changed different words, combine them' } },
                });
            }
        }
        for (const pane of PANES) {
            this.decorations[pane].set(lists[pane]);
        }
    }

    private wordDecorations(chunk: MergeChunk, side: Side, sideStyle: ChangeStyle, resultStyle: ChangeStyle, lists: Record<Pane, Decoration[]>): void {
        const diff = wordDiff(this.regionText(chunk), chunk.sideText(side));
        if (!diff) {
            return;
        }
        const sideModel = this.editors[side].getModel()!;
        const sideStart = sideModel.getOffsetAt({ lineNumber: chunk.sideLines(side).start + 1, column: 1 });
        const push = (list: Decoration[], model: monaco.editor.ITextModel, base: number, start: number, end: number, style: ChangeStyle) =>
            list.push({ range: monaco.Range.fromPositions(model.getPositionAt(base + start), model.getPositionAt(base + end)), options: { inlineClassName: `mg-word mg-${style}` } });
        diff.inB.forEach(r => push(lists[side], sideModel, sideStart, r.start, r.end, sideStyle));
        diff.inA.forEach(r => push(lists.result, this.resultModel, chunk.start, r.start, r.end, resultStyle));
    }

    private resultStyle(chunk: MergeChunk): ChangeStyle | undefined {
        if (chunk.resolved) {
            return undefined;
        }
        return chunk.isConflict ? 'conflict' : shapeStyle(chunk, chunk.kind === 'theirs' ? 'theirs' : 'ours');
    }

    private renderStatus(): void {
        const { pendingChanges, unresolvedConflicts } = this.model.stats();
        if (pendingChanges === 0 && unresolvedConflicts === 0) {
            this.statusEl.innerHTML = `<span class="done">${ICONS.check} All changes have been processed.</span> <a href="#" data-host="apply">Save changes and finish merging</a>`;
        } else {
            const changes = pendingChanges === 0 ? 'No changes' : plural(pendingChanges, 'change');
            const conflicts = unresolvedConflicts === 0 ? 'No conflicts' : plural(unresolvedConflicts, 'conflict');
            this.statusEl.textContent = `${changes}. ${conflicts}.`;
        }
    }

    refreshTheme(): void {
        const font = editorFont();
        PANES.forEach(p => this.editors[p].updateOptions(font));
        this.render();
    }

    // ---- State reporting ----

    private state(): ViewState {
        const position = this.editors[this.lastFocused].getPosition();
        const chunk = position ? this.chunkAt(this.lastFocused, position.lineNumber - 1) : undefined;
        const index = chunk?.isConflict ? this.model.conflicts.indexOf(chunk) + 1 : undefined;
        return {
            stats: this.model.stats(),
            dirty: this.resultModel.getAlternativeVersionId() !== this.initialVersion,
            currentConflict: index,
        };
    }

    private schedulePostState(): void {
        if (this.stateTimer === undefined) {
            this.stateTimer = setTimeout(() => this.postState(), STATE_DELAY_MS);
        }
    }

    private postState(): void {
        if (this.stateTimer !== undefined) {
            clearTimeout(this.stateTimer);
            this.stateTimer = undefined;
        }
        this.post({ type: 'state', state: this.state() });
    }

    // ---- Wiring ----

    private wireEditors(): void {
        const result = this.resultModel;
        this.disposables.push(result.onDidChangeContent(e => {
            this.model.handleDocumentChange(
                e.changes.map(c => ({ rangeOffset: c.rangeOffset, rangeLength: c.rangeLength, text: c.text })),
                (start, end) => result.getValueInRange(monaco.Range.fromPositions(result.getPositionAt(start), result.getPositionAt(end))),
            );
            this.changed();
        }));

        for (const pane of PANES) {
            const editor = this.editors[pane];
            this.disposables.push(
                editor.onDidFocusEditorText(() => { this.lastFocused = pane; }),
                editor.onDidChangeCursorPosition(() => this.schedulePostState()),
                editor.onDidLayoutChange(() => this.scheduleRender()),
                editor.onDidScrollChange(e => {
                    if (!this.syncing) {
                        if (e.scrollTopChanged) {
                            this.syncFrom(pane);
                        }
                        if (e.scrollLeftChanged) {
                            this.syncing = true;
                            PANES.filter(p => p !== pane).forEach(p => this.editors[p].setScrollLeft(e.scrollLeft));
                            this.syncing = false;
                        }
                    }
                    this.dividers.forEach(d => d.render());
                }),
            );
            this.addKeybindings(pane, editor);
        }

        this.disposables.push(this.editors.result.onMouseDown(e => {
            const line = e.target.position?.lineNumber;
            if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && line !== undefined) {
                const chunk = this.model.chunks.find(c => c.isConflict && c.simpleResolution !== undefined && Math.min(this.lines(c, 'result').start + 1, this.resultModel.getLineCount()) === line);
                if (chunk) {
                    this.handle({ type: 'action', action: 'resolveSimple', chunkId: chunk.id });
                }
            }
        }));
    }

    private addKeybindings(pane: Pane, editor: monaco.editor.IStandaloneCodeEditor): void {
        const { KeyMod, KeyCode } = monaco;
        const acceptMods = IS_MAC ? KeyMod.WinCtrl | KeyMod.CtrlCmd : KeyMod.CtrlCmd | KeyMod.Alt;
        const run = (action: MergeAction) => () => this.handle({ type: 'action', action });
        const actions: monaco.editor.IActionDescriptor[] = [
            { id: 'merge.next', label: 'Next Conflict', keybindings: [KeyCode.F7], run: run('nextConflict') },
            { id: 'merge.previous', label: 'Previous Conflict', keybindings: [KeyMod.Shift | KeyCode.F7], run: run('previousConflict') },
            { id: 'merge.acceptYours', label: 'Accept Left (Yours)', keybindings: [acceptMods | KeyCode.RightArrow], run: run('acceptYours'), contextMenuGroupId: '1_merge', contextMenuOrder: 1 },
            { id: 'merge.acceptTheirs', label: 'Accept Right (Theirs)', keybindings: [acceptMods | KeyCode.LeftArrow], run: run('acceptTheirs'), contextMenuGroupId: '1_merge', contextMenuOrder: 2 },
            { id: 'merge.ignoreYours', label: 'Ignore Left (Yours)', run: run('ignoreYours'), contextMenuGroupId: '1_merge', contextMenuOrder: 3 },
            { id: 'merge.ignoreTheirs', label: 'Ignore Right (Theirs)', run: run('ignoreTheirs'), contextMenuGroupId: '1_merge', contextMenuOrder: 4 },
            { id: 'merge.acceptBoth', label: 'Accept Both (Left, then Right)', run: run('acceptBoth'), contextMenuGroupId: '1_merge', contextMenuOrder: 5 },
            { id: 'merge.resolveSimple', label: 'Resolve Simple Conflict', run: run('resolveSimple'), contextMenuGroupId: '1_merge', contextMenuOrder: 6 },
            { id: 'merge.revert', label: 'Revert Conflict Resolution', run: run('revertResolution'), contextMenuGroupId: '1_merge', contextMenuOrder: 7 },
        ];
        if (pane !== 'result') {
            // Undo/redo from a read-only pane act on the Result.
            const result = this.editors.result;
            actions.push(
                { id: 'merge.undo', label: 'Undo in Result', keybindings: [KeyMod.CtrlCmd | KeyCode.KeyZ], run: () => result.trigger('keyboard', 'undo', null) },
                { id: 'merge.redo', label: 'Redo in Result', keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, KeyMod.CtrlCmd | KeyCode.KeyY], run: () => result.trigger('keyboard', 'redo', null) },
            );
        }
        actions.forEach(a => this.disposables.push(editor.addAction(a)));
    }

    private wireToolbar(): void {
        this.root.addEventListener('mousedown', e => {
            if ((e.target as Element).closest('.toolbar button, .footer button')) {
                e.preventDefault(); // keep the editor focus and cursor
            }
        });
        this.root.addEventListener('click', e => {
            const target = (e.target as Element).closest<HTMLElement>('[data-cmd], [data-host], [data-toggle]');
            if (!target) {
                return;
            }
            e.preventDefault();
            const { cmd, host, toggle } = target.dataset;
            if (cmd) {
                this.handle({ type: 'action', action: cmd as MergeAction });
            } else if (toggle === 'words') {
                this.highlightWords = !this.highlightWords;
                target.classList.toggle('on', this.highlightWords);
                target.setAttribute('aria-pressed', String(this.highlightWords));
                this.render();
            } else if (host === 'apply' || host === 'cancel') {
                this.post({ type: host });
            } else if (host === 'compare') {
                this.post({ type: 'compare', which: target.dataset.which as ComparisonId | undefined });
            } else if (host?.startsWith('acceptFile:')) {
                this.post({ type: 'acceptFile', side: host.slice('acceptFile:'.length) as Side });
            }
        });
        // Outside the editors (e.g. on a toolbar button), F7 / Shift+F7 reach VS Code's keybindings (package.json).
    }

    /**
     * Dragging a divider resizes the two panes next to it (double-click restores equal widths). Widths are kept as
     * flex-grow ratios so the split survives resizing the editor area; Monaco re-lays itself out (automaticLayout).
     */
    private wireSplitters(): void {
        const panes = [...this.root.querySelectorAll<HTMLElement>('.panes > .col-side, .panes > .col-result')];
        const setWidths = (widths: readonly number[]) => panes.forEach((pane, k) => { pane.style.flex = `${widths[k]} 1 0`; });
        const handles = [...this.root.querySelectorAll<HTMLElement>('.panes > .col-divider')];

        handles.forEach((handle, i) => {
            handle.addEventListener('pointerdown', e => {
                if (e.button !== 0 || (e.target as Element).closest('.act')) {
                    return; // accept/ignore buttons keep working
                }
                e.preventDefault();
                const widths = panes.map(p => p.getBoundingClientRect().width);
                const pair = widths[i] + widths[i + 1];
                const startX = e.clientX;
                handle.setPointerCapture(e.pointerId);
                document.body.classList.add('mg-resizing');

                const move = (ev: PointerEvent) => {
                    const left = Math.min(Math.max(widths[i] + ev.clientX - startX, MIN_PANE_WIDTH), pair - MIN_PANE_WIDTH);
                    const next = [...widths];
                    next[i] = left;
                    next[i + 1] = pair - left;
                    setWidths(next);
                };
                const end = () => {
                    document.body.classList.remove('mg-resizing');
                    handle.removeEventListener('pointermove', move);
                    handle.removeEventListener('pointerup', end);
                    handle.removeEventListener('pointercancel', end);
                    this.scheduleRender();
                };
                handle.addEventListener('pointermove', move);
                handle.addEventListener('pointerup', end);
                handle.addEventListener('pointercancel', end);
            });
            handle.addEventListener('dblclick', e => {
                if (!(e.target as Element).closest('.act')) {
                    setWidths([1, 1, 1]);
                }
            });
        });
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        for (const pane of PANES) {
            const model = this.editors[pane].getModel();
            this.editors[pane].dispose();
            model?.dispose();
        }
        if (this.stateTimer !== undefined) {
            clearTimeout(this.stateTimer);
        }
    }
}

/** How a side's change relates to Base: lines added, deleted, or modified. */
function shapeStyle(chunk: MergeChunk, side: Side): ChangeStyle {
    const base = chunk.baseLines;
    const own = chunk.sideLines(side);
    if (base.end === base.start) {
        return 'added';
    }
    return own.end === own.start ? 'deleted' : 'modified';
}

/** Adds the decorations for a highlighted block of lines (or a thin marker for an insertion point). */
function block(list: Decoration[], model: monaco.editor.ITextModel, r: LineRange, style: ChangeStyle, ruler: Record<ChangeStyle, string>, margin: boolean): void {
    const overviewRuler = { color: ruler[style], position: monaco.editor.OverviewRulerLane.Full };
    const lineCount = model.getLineCount();
    if (r.end <= r.start) {
        const atEnd = r.start >= lineCount;
        const line = atEnd ? lineCount : r.start + 1;
        const className = `mg-mark-${atEnd ? 'bottom' : 'top'} mg-${style}`;
        list.push({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className, marginClassName: margin ? className : undefined, overviewRuler } });
        return;
    }
    // First and last lines carry the block's top/bottom border lines.
    const lines = (from: number, to: number, edges: string) => {
        const classes = `mg-${style}${edges}`;
        list.push({
            range: new monaco.Range(from, 1, to, 1),
            options: { isWholeLine: true, className: `mg-line ${classes}`, marginClassName: margin ? `mg-margin ${classes}` : undefined, overviewRuler },
        });
    };
    const first = r.start + 1;
    const last = Math.min(r.end, lineCount);
    if (first === last) {
        lines(first, first, ' mg-edge-top mg-edge-bottom');
        return;
    }
    lines(first, first, ' mg-edge-top');
    if (last - first > 1) {
        lines(first + 1, last - 1, '');
    }
    lines(last, last, ' mg-edge-bottom');
}

/** Overview-ruler colors must be concrete values; read them from the palette CSS variables. */
function rulerColors(): Record<ChangeStyle, string> {
    const style = getComputedStyle(document.body);
    const read = (s: ChangeStyle) => style.getPropertyValue(`--mg-${s}-border`).trim() || '#888';
    return { conflict: read('conflict'), modified: read('modified'), added: read('added'), deleted: read('deleted') };
}

/** VS Code language ids that Monaco knows under another name. */
const LANGUAGE_ALIASES: Record<string, string> = {
    typescriptreact: 'typescript', javascriptreact: 'javascript', json: 'javascript', jsonc: 'javascript', json5: 'javascript',
    shellscript: 'shell', dockercompose: 'yaml', 'github-actions-workflow': 'yaml', blade: 'html', vue: 'html', svelte: 'html',
    'jinja-html': 'html', 'php-html': 'php', ignore: 'plaintext', properties: 'ini', makefile: 'plaintext', 'git-commit': 'plaintext',
};

function resolveLanguage(languageId: string, fileName: string): string {
    const known = new Set(monaco.languages.getLanguages().map(l => l.id));
    const id = LANGUAGE_ALIASES[languageId] ?? languageId;
    if (known.has(id)) {
        return id;
    }
    const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
    return monaco.languages.getLanguages().find(l => l.extensions?.includes(extension))?.id ?? 'plaintext';
}

function layout(data: InitData): string {
    const header = (side: Side) => {
        const label = side === 'ours' ? data.oursLabel : data.theirsLabel;
        const which: ComparisonId = side === 'ours' ? 'base-ours' : 'base-theirs';
        return `<div class="col-header">${ICONS.lock}<span class="label">Changes from <b>${escapeHtml(label)}</b></span>`
            + `<a href="#" class="details" data-host="compare" data-which="${which}" title="Show what ${escapeHtml(label)} changed compared to the common base">Show Details</a></div>`;
    };
    return `
<div class="toolbar" role="toolbar">
  <button class="tb" data-cmd="previousConflict" title="Previous Conflict (Shift+F7)" aria-label="Previous conflict">${ICONS.up}</button>
  <button class="tb" data-cmd="nextConflict" title="Next Conflict (F7)" aria-label="Next conflict">${ICONS.down}</button>
  <span class="sep"></span>
  <span class="tb-label">Apply non-conflicting changes:</span>
  <button class="tb" data-cmd="applyNonConflictingYours" title="Apply non-conflicting changes from the left side" aria-label="Apply left non-conflicting changes">${ICONS.acceptFromLeft}</button>
  <button class="tb" data-cmd="applyNonConflicting" title="Apply all non-conflicting changes" aria-label="Apply all non-conflicting changes">${ICONS.applyAll}</button>
  <button class="tb" data-cmd="applyNonConflictingTheirs" title="Apply non-conflicting changes from the right side" aria-label="Apply right non-conflicting changes">${ICONS.acceptFromRight}</button>
  <button class="tb" data-cmd="resolveAllSimple" title="Resolve simple conflicts (both sides changed different words)" aria-label="Resolve simple conflicts">${ICONS.wand}</button>
  <span class="sep"></span>
  <button class="tb tb-text tb-toggle on" data-toggle="words" aria-pressed="true" title="Highlight the changed words inside each change">${ICONS.check}<span>Highlight words</span></button>
  <button class="tb tb-text" data-host="compare" title="Compare two versions in a VS Code diff editor">${ICONS.compare}<span>Compare…</span></button>
  <span class="spacer"></span>
  <span class="status" id="status" role="status" aria-live="polite"></span>
</div>
<div class="panes">
  <div class="col col-side">${header('ours')}<div class="editor" id="ed-ours"></div></div>
  <div class="col col-divider"><div class="col-header"></div><div id="dv-ours"></div></div>
  <div class="col col-result"><div class="col-header"><span class="title">Result</span><span class="path">${escapeHtml(data.relativePath)}</span></div><div class="editor" id="ed-result"></div></div>
  <div class="col col-divider"><div class="col-header"></div><div id="dv-theirs"></div></div>
  <div class="col col-side">${header('theirs')}<div class="editor" id="ed-theirs"></div></div>
</div>
<div class="footer">
  <button class="btn" data-host="acceptFile:ours" title="Resolve the whole file with the left version (${escapeHtml(data.oursLabel)})">Accept Left</button>
  <button class="btn" data-host="acceptFile:theirs" title="Resolve the whole file with the right version (${escapeHtml(data.theirsLabel)})">Accept Right</button>
  <span class="spacer"></span>
  <button class="btn" data-host="cancel">Cancel</button>
  <button class="btn primary" data-host="apply" title="Save the Result to the file and mark it as resolved">Apply</button>
</div>`;
}

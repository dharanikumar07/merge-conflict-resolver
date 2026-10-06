import type { MergeChunk, Side } from '../merge/MergeChunk';
import { ICONS } from './icons';
import * as monaco from './monaco';

export type Pane = Side | 'result';
export type ChangeStyle = 'conflict' | 'modified' | 'added' | 'deleted';
export type ChunkAction = 'accept' | 'ignore';

/** Line range [start, end), 0-based. An empty range is an insertion point before `start`. */
export interface LineRange {
    start: number;
    end: number;
}

export interface DividerSource {
    editor(pane: Pane): monaco.editor.IStandaloneCodeEditor;
    chunks(): readonly MergeChunk[];
    lines(chunk: MergeChunk, pane: Pane): LineRange;
    /** Highlight style of a side's change, or undefined once that side has been handled. */
    sideStyle(chunk: MergeChunk, side: Side): ChangeStyle | undefined;
    /** The other side of this conflict is already in the Result, so accepting appends. */
    appends(chunk: MergeChunk, side: Side): boolean;
    shortcut(side: Side): string;
    act(side: Side, chunkId: number, action: ChunkAction): void;
}

const CONNECTOR_WIDTH = 34;
const ACTIONS_WIDTH = 46;
const BUTTON_SIZE = 20;

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * The strip between a side pane and the Result, like in PhpStorm:
 *   Yours:  [text] [✕ ≫] [line numbers] [connector] [Result]
 *   Theirs: [Result] [connector] [line numbers] [≪ ✕] [text]
 * The connector draws a curved band from each pending change to its region in the Result.
 */
export class Divider {
    private readonly gutter: HTMLElement;
    private readonly svg: SVGSVGElement;
    private numbersWidth = 0;

    constructor(private readonly el: HTMLElement, private readonly side: Side, private readonly source: DividerSource) {
        el.classList.add('divider', `divider-${side}`);
        el.innerHTML = side === 'ours'
            ? `<div class="gutter"></div><svg class="connector" width="${CONNECTOR_WIDTH}"></svg>`
            : `<svg class="connector" width="${CONNECTOR_WIDTH}"></svg><div class="gutter"></div>`;
        this.gutter = el.querySelector('.gutter')!;
        this.svg = el.querySelector('svg')!;

        this.gutter.addEventListener('mousedown', e => e.preventDefault()); // keep the editor focus
        this.gutter.addEventListener('click', e => {
            const button = (e.target as Element).closest<HTMLElement>('[data-act]');
            if (button) {
                this.source.act(this.side, Number(button.dataset.chunk), button.dataset.act as ChunkAction);
            }
        });
        // Scrolling over the strip scrolls the panes, as in PhpStorm.
        el.addEventListener('wheel', e => {
            const editor = this.source.editor('result');
            const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
            const factor = e.deltaMode === 1 ? lineHeight : e.deltaMode === 2 ? editor.getLayoutInfo().height : 1;
            editor.setScrollTop(editor.getScrollTop() + e.deltaY * factor);
            editor.setScrollLeft(editor.getScrollLeft() + e.deltaX * factor);
            e.preventDefault();
        }, { passive: false });
    }

    render(): void {
        const editor = this.source.editor(this.side);
        const result = this.source.editor('result');
        const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
        const resultLineHeight = result.getOption(monaco.editor.EditorOption.lineHeight);
        const scrollTop = editor.getScrollTop();
        const resultScrollTop = result.getScrollTop();
        const height = this.el.clientHeight;
        const lineCount = editor.getModel()?.getLineCount() ?? 1;
        this.updateWidth(editor, lineCount);

        let backgrounds = '';
        let numbers = '';
        let actions = '';
        let bands = '';
        const w = CONNECTOR_WIDTH;
        const mid = w / 2;

        for (const chunk of this.source.chunks()) {
            const style = this.source.sideStyle(chunk, this.side);
            if (!style) {
                continue;
            }
            const own = this.source.lines(chunk, this.side);
            const res = this.source.lines(chunk, 'result');
            const y1 = own.start * lineHeight - scrollTop;
            const y2 = own.end * lineHeight - scrollTop;
            const r1 = res.start * resultLineHeight - resultScrollTop;
            const r2 = res.end * resultLineHeight - resultScrollTop;
            if (Math.max(y2, r2) < -lineHeight || Math.min(y1, r1) > height + lineHeight) {
                continue; // not visible on either side
            }

            backgrounds += y2 > y1
                ? `<div class="g-block mg-${style}" style="top:${y1}px;height:${y2 - y1}px"></div>`
                : `<div class="g-mark mg-${style}" style="top:${y1 - 1}px"></div>`;

            // Band from the side's lines (left edge for Yours, right edge for Theirs) to the Result's lines.
            const [l1, l2, rr1, rr2] = this.side === 'ours' ? [y1, y2, r1, r2] : [r1, r2, y1, y2];
            bands += `<path class="band-fill mg-${style}" d="M0 ${l1} C${mid} ${l1} ${mid} ${rr1} ${w} ${rr1} L${w} ${rr2} C${mid} ${rr2} ${mid} ${l2} 0 ${l2} Z"/>`
                + `<path class="band-edge mg-${style}" d="M0 ${l1} C${mid} ${l1} ${mid} ${rr1} ${w} ${rr1}"/>`
                + (l2 !== l1 || rr2 !== rr1 ? `<path class="band-edge mg-${style}" d="M0 ${l2} C${mid} ${l2} ${mid} ${rr2} ${w} ${rr2}"/>` : '');

            const top = y2 > y1 ? y1 + (lineHeight - BUTTON_SIZE) / 2 : y1 - BUTTON_SIZE / 2;
            actions += this.actionButtons(chunk, style, top);
        }

        const first = Math.max(1, Math.floor(scrollTop / lineHeight) + 1);
        const last = Math.min(lineCount, Math.ceil((scrollTop + height) / lineHeight));
        for (let n = first; n <= last; n++) {
            numbers += `<div class="ln" style="top:${(n - 1) * lineHeight - scrollTop}px;height:${lineHeight}px;line-height:${lineHeight}px">${n}</div>`;
        }

        this.gutter.innerHTML = backgrounds + numbers + actions;
        this.svg.setAttribute('height', String(height));
        this.svg.innerHTML = bands;
    }

    private actionButtons(chunk: MergeChunk, style: ChangeStyle, top: number): string {
        const appends = this.source.appends(chunk, this.side);
        const fromLeft = this.side === 'ours';
        const icon = appends
            ? (fromLeft ? ICONS.appendFromLeft : ICONS.appendFromRight)
            : (fromLeft ? ICONS.acceptFromLeft : ICONS.acceptFromRight);
        const sideName = fromLeft ? 'left' : 'right';
        const acceptTitle = appends
            ? `Append: insert the ${sideName} change after the change already accepted`
            : `Accept the ${sideName} change into the Result (${this.source.shortcut(this.side)})`;
        const accept = `<button class="act act-accept mg-${style}" data-act="accept" data-chunk="${chunk.id}" title="${escapeAttr(acceptTitle)}">${icon}</button>`;
        const ignore = `<button class="act act-ignore" data-act="ignore" data-chunk="${chunk.id}" title="Ignore the ${sideName} change (keep the Result as it is)">${ICONS.ignore}</button>`;
        return `<div class="acts" style="top:${top}px">${fromLeft ? ignore + accept : accept + ignore}</div>`;
    }

    private updateWidth(editor: monaco.editor.IStandaloneCodeEditor, lineCount: number): void {
        const charWidth = editor.getOption(monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
        const numbersWidth = Math.ceil(Math.max(2, String(lineCount).length) * charWidth + 14);
        if (numbersWidth !== this.numbersWidth) {
            this.numbersWidth = numbersWidth;
            this.gutter.style.width = `${ACTIONS_WIDTH + numbersWidth}px`;
            this.gutter.style.setProperty('--numbers-width', `${numbersWidth}px`);
            this.gutter.style.setProperty('--actions-width', `${ACTIONS_WIDTH}px`);
        }
    }
}

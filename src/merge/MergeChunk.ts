import { IndexRange } from './MergeEngine';

export type Side = 'ours' | 'theirs';
export type ChangeKind = 'ours' | 'theirs' | 'both' | 'conflict';

/**
 * none    – this side did not change the region
 * pending – this side changed the region and the user has not decided yet
 * applied – the side's change was copied into the result
 * ignored – the user chose not to take the side's change
 */
export type SideState = 'none' | 'pending' | 'applied' | 'ignored';

interface Snapshot {
    text: string;
    ours: SideState;
    theirs: SideState;
}

const MAX_HISTORY = 32;

/** A changed region of a three-way merge, plus its live position and resolution state in the result document. */
export class MergeChunk {
    oursState: SideState;
    theirsState: SideState;
    /** The user typed inside the region; counts as resolved. */
    edited = false;
    /** Start/end offsets of the region in the result document, kept up to date as the document changes. */
    start = 0;
    end = 0;

    private readonly history: Snapshot[];

    constructor(
        readonly id: number,
        readonly kind: ChangeKind,
        /** Line ranges of this chunk inside each version. */
        readonly baseLines: IndexRange,
        readonly oursLines: IndexRange,
        readonly theirsLines: IndexRange,
        readonly baseText: string,
        readonly oursText: string,
        readonly theirsText: string,
        readonly simpleResolution: string | undefined,
    ) {
        this.oursState = kind === 'theirs' ? 'none' : 'pending';
        this.theirsState = kind === 'ours' ? 'none' : 'pending';
        this.history = [{ text: baseText, ours: this.oursState, theirs: this.theirsState }];
    }

    get isConflict(): boolean {
        return this.kind === 'conflict';
    }

    get resolved(): boolean {
        return this.edited || (this.oursState !== 'pending' && this.theirsState !== 'pending');
    }

    state(side: Side): SideState {
        return side === 'ours' ? this.oursState : this.theirsState;
    }

    sideText(side: Side): string {
        return side === 'ours' ? this.oursText : this.theirsText;
    }

    sideLines(side: Side | 'base'): IndexRange {
        return side === 'ours' ? this.oursLines : side === 'theirs' ? this.theirsLines : this.baseLines;
    }

    /** Records the state the chunk will be in once `text` is in the result (called before the edit is applied). */
    setState(text: string, ours: SideState, theirs: SideState): void {
        this.oursState = ours;
        this.theirsState = theirs;
        this.edited = false;
        this.history.push({ text, ours, theirs });
        if (this.history.length > MAX_HISTORY) {
            this.history.splice(1, 1); // always keep the initial snapshot
        }
    }

    reset(): void {
        const initial = this.history[0];
        this.setState(initial.text, initial.ours, initial.theirs);
    }

    /**
     * Re-derives the state from the region's current text. This keeps the state correct across undo/redo:
     * if the text matches a state we produced earlier, that state is restored; otherwise it was edited by hand.
     */
    syncWithText(currentText: string): void {
        for (let k = this.history.length - 1; k >= 0; k--) {
            const snapshot = this.history[k];
            if (snapshot.text === currentText) {
                this.oursState = snapshot.ours;
                this.theirsState = snapshot.theirs;
                this.edited = false;
                return;
            }
        }
        this.edited = true;
    }
}

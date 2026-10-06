/**
 * Messages exchanged between the extension host (MergeSession) and the merge webview.
 * The merge state (MergeModel) lives in the webview next to the editors; the host owns Git and the file system.
 */
import type { ChangeKind, SideState } from '../merge/MergeChunk';
import type { MergeStats } from '../merge/MergeModel';

export type Side = 'ours' | 'theirs';

/** Actions the host can ask the webview to perform (commands, keybindings, Complete Merge). */
export type MergeAction =
    | 'acceptYours' | 'acceptTheirs' | 'ignoreYours' | 'ignoreTheirs' | 'acceptBoth'
    | 'resolveSimple' | 'revertResolution'
    | 'applyNonConflicting' | 'applyNonConflictingYours' | 'applyNonConflictingTheirs' | 'resolveAllSimple'
    | 'nextConflict' | 'previousConflict'
    | 'revealLine'
    /** Does nothing; used to read the current state. */
    | 'sync';

export type ComparisonId = 'ours-theirs' | 'base-ours' | 'base-theirs' | 'ours-result' | 'theirs-result' | 'base-result';

export interface InitData {
    fileName: string;
    /** Workspace-relative path, shown in the Result header. */
    relativePath: string;
    languageId: string;
    eol: '\n' | '\r\n';
    base: string;
    ours: string;
    theirs: string;
    oursLabel: string;
    theirsLabel: string;
    autoApplyNonConflicting: boolean;
}

export interface ViewState {
    stats: MergeStats;
    /** The Result differs from its initial content. */
    dirty: boolean;
    /** 1-based index of the conflict at the cursor, if any. */
    currentConflict?: number;
}

export interface ChunkSummary {
    id: number;
    kind: ChangeKind;
    ours: SideState;
    theirs: SideState;
    resolved: boolean;
}

export interface ActionReply {
    state: ViewState;
    result: string;
    chunks: ChunkSummary[];
    error?: string;
}

export type HostMessage =
    | { type: 'init'; data: InitData }
    | { type: 'action'; action: MergeAction; chunkId?: number; line?: number; requestId?: number };

export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'state'; state: ViewState }
    | { type: 'reply'; requestId: number; reply: ActionReply }
    /** Footer / toolbar buttons that need the host. */
    | { type: 'apply' }
    | { type: 'acceptFile'; side: Side }
    | { type: 'cancel' }
    | { type: 'compare'; which?: ComparisonId }
    | { type: 'info'; message: string };

/**
 * Monaco editor build for the merge webview: the core editor API, the standard editor contributions
 * (find, folding, multi-cursor, ...) and the Monarch syntax highlighters for all basic languages.
 * Language services (TypeScript, CSS, JSON, HTML workers) are intentionally left out to keep the bundle small.
 */
import 'monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/caretOperations/browser/transpose';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget';
import 'monaco-editor/editor/contrib/comment/browser/comment';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo';
import 'monaco-editor/editor/contrib/dnd/browser/dnd';
import 'monaco-editor/editor/contrib/folding/browser/folding';
import 'monaco-editor/editor/contrib/fontZoom/browser/fontZoom';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution';
import 'monaco-editor/editor/contrib/indentation/browser/indentation';
import 'monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace';
import 'monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine';
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations';
import 'monaco-editor/editor/contrib/links/browser/links';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor';
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2';
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode';
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization';
import 'monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter';
import 'monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations';
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations';
import 'monaco-editor/editor/browser/coreCommands';
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController';
import 'monaco-editor/editor/common/standaloneStrings';
import '../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import 'monaco-editor/features/find/register';
import '../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css';
import 'monaco-editor/languages/definitions/register.all';
export * from 'monaco-editor/editor/editor.api';

/** 16×16 stroke icons modelled on the IntelliJ merge dialog. They inherit `currentColor`. */
const svg = (body: string) =>
    `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
    /** ≫ — take the left change into the Result. */
    acceptFromLeft: svg('<path d="M3 3.5 7.5 8 3 12.5M8.5 3.5 13 8l-4.5 4.5"/>'),
    /** ≪ — take the right change into the Result. */
    acceptFromRight: svg('<path d="M13 3.5 8.5 8l4.5 4.5M7.5 3.5 3 8l4.5 4.5"/>'),
    /** ↳ — append the left change after the change already taken from the right. */
    appendFromLeft: svg('<path d="M4 2.5v7h8.5M9.5 6.5l3 3-3 3"/>'),
    /** ↲ — append the right change after the change already taken from the left. */
    appendFromRight: svg('<path d="M12 2.5v7H3.5M6.5 6.5l-3 3 3 3"/>'),
    ignore: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
    applyAll: svg('<path d="M1.5 4 5 8l-3.5 4M14.5 4 11 8l3.5 4M8 3v10"/>'),
    wand: svg('<path d="M2.5 13.5 10 6M8.5 4.5l3 3M12.5 1.5v2.5M11.25 2.75h2.5M14 6.5v2M13 7.5h2M5.5 1.5v2M4.5 2.5h2"/>'),
    up: svg('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>'),
    down: svg('<path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/>'),
    lock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/>'),
    check: svg('<path d="M3 8.5l3.2 3.2L13 4.8"/>'),
    compare: svg('<rect x="1.5" y="2.5" width="5.5" height="11" rx="1"/><rect x="9" y="2.5" width="5.5" height="11" rx="1"/><path d="M3.5 6h1.5M11 6h1.5M3.5 9h1.5M11 9h1.5"/>'),
};

export const styles = `
    :root {
        --bg: #1e1e1e;
        --header: #3c3f41;
        --border: #323232;
        --gutter: #2b2b2b;
        --line-num: #606366;
        --added-bg: rgba(73, 156, 100, 0.15);
        --added-border: #499c64;
        --removed-bg: rgba(186, 62, 62, 0.15);
        --removed-border: #ba3e3e;
        --modified-bg: rgba(65, 108, 161, 0.2);
        --modified-border: #416ca1;
        --accent: #3574f0;
    }
    body { margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: #bbb; font-family: 'Segoe UI', sans-serif; overflow: hidden; }
    
    .toolbar { background: #2d2d2d; padding: 10px 20px; border-bottom: 1px solid var(--border); font-size: 13px; color: #fff; display: flex; justify-content: space-between; align-items: center; }
    
    .editor-container { display: flex; flex: 1; overflow: hidden; position: relative; }
    .column { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; }
    .result-column { flex: 1.3; background: #1a1a1a; }
    .column-header { background: var(--header); padding: 6px 15px; font-size: 11px; color: #aaa; text-transform: uppercase; border-bottom: 1px solid var(--border); }
    
    .content { flex: 1; overflow-y: auto; overflow-x: auto; font-family: 'JetBrains Mono', monospace; font-size: 12px; line-height: 1.8; white-space: pre; position: relative; scrollbar-width: thin; }
    
    /* 📦 Perfect Alignment Logic */
    .master-row { display: flex; width: 100%; min-width: fit-content; align-items: stretch; }
    .line-row { display: flex; width: 100%; min-height: 1.8em; box-sizing: border-box; }
    .line-num { width: 45px; text-align: right; padding-right: 12px; color: var(--line-num); background: var(--gutter); user-select: none; border-right: 1px solid #333; flex-shrink: 0; }
    .line-text { padding-left: 10px; flex: 1; min-height: 1.8em; display: flex; align-items: center; }

    /* Block Styling */
    .block-added { background: var(--added-bg); border-left: 3px solid var(--added-border); }
    .block-removed { background: var(--removed-bg); border-left: 3px solid var(--removed-border); }
    .block-modified { background: var(--modified-bg); border-left: 3px solid var(--modified-border); }
    .block-empty { opacity: 0.2; }

    /* ↔️ Gutter & Centered Action Icons */
    .gutter { width: 40px; background: var(--gutter); display: flex; flex-direction: column; border-left: 1px solid var(--border); border-right: 1px solid var(--border); flex-shrink: 0; position: relative; }
    .action-container { 
        position: absolute; 
        width: 100%; 
        display: flex; 
        flex-direction: column; 
        align-items: center; 
        justify-content: center; 
        gap: 4px;
        z-index: 20;
    }
    
    .btn-icon { 
        cursor: pointer; 
        color: #fff; 
        font-size: 14px; 
        width: 24px; 
        height: 20px; 
        display: flex; 
        align-items: center; 
        justify-content: center; 
        border-radius: 2px; 
        box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        transition: transform 0.1s, filter 0.1s;
    }
    .btn-icon:hover { transform: scale(1.1); filter: brightness(1.2); }
    .btn-acc { background: var(--added-border); }
    .btn-x { background: var(--removed-border); font-size: 10px; }

    .footer { padding: 12px 20px; background: #2d2d2d; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 10px; }
    .btn { border: none; padding: 6px 20px; border-radius: 3px; cursor: pointer; font-size: 13px; font-weight: 500; }
    .btn-apply { background: var(--accent); color: white; }
    .btn-cancel { background: transparent; color: #aaa; border: 1px solid #444; }
`;

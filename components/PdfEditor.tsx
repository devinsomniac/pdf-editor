'use client';

import { useEffect } from 'react';
import { initEditor } from '../lib/editor';

export default function PdfEditor() {
    useEffect(() => {
    let cleanup: (() => void) | undefined;
    let unmounted = false;
    initEditor()
      .then((fn: () => void) => {
        if (unmounted) fn();
        else cleanup = fn;
      })
      .catch((err: unknown) => {
        console.error('Editor failed to start:', err);
      });
    return () => {
      unmounted = true;
      cleanup?.();
    };
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M4 7V4h16v3M9 20h6M12 4v16" /></svg>
          </div>
          Insomniac PDF Editor
        </div>
        <div className="filename" id="fname"></div>
        <div className="spacer"></div>
        <button className="btn" id="openBtn" title="Open another PDF">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></svg>
          <span>Open</span>
        </button>
        <button className="btn icon" id="undoBtn" title="Undo (Ctrl+Z)" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
        </button>
        <button className="btn icon" id="redoBtn" title="Redo (Ctrl+Shift+Z)" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>
        </button>
        <div className="zoom">
          <button className="btn icon" id="zoomOut" title="Zoom out">−</button>
          <span id="zoomLbl">100%</span>
          <button className="btn icon" id="zoomIn" title="Zoom in">+</button>
        </div>
        <button className="btn primary" id="saveBtn" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>
          Apply &amp; download
        </button>
      </header>

      <div className="toolbar" id="toolbar">
        <button className="tool" data-tool="select" title="Select & move (V)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M5 3l14 8-6 2-3 6z" /></svg>
          <span>Select</span>
        </button>
        <button className="tool active" data-tool="text" title="Add text (T)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 6V4h14v2M9 20h6M12 4v16" /></svg>
          <span>Text</span>
        </button>
        <button className="tool" data-tool="whiteout" title="Whiteout: drag to cover existing content (W)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="6" width="16" height="12" rx="2" /><path d="M8 10h8M8 14h5" strokeLinecap="round" /></svg>
          <span>Whiteout</span>
        </button>
        <button className="tool" id="imageTool" title="Insert an image">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 17-5-5-9 8" /></svg>
          <span>Image</span>
        </button>
        <div className="sep"></div>
        <select className="ctl" id="fontSel" title="Font" defaultValue="Helvetica">
          <option value="Helvetica">Helvetica</option>
          <option value="Times">Times</option>
          <option value="Courier">Courier</option>
        </select>
        <input className="ctl size" id="sizeIn" type="number" min="4" max="200" step="1" defaultValue="14" title="Font size (pt)" />
        <button className="toggle" id="boldBtn" title="Bold"><b>B</b></button>
        <button className="toggle" id="italBtn" title="Italic"><i style={{ fontFamily: 'Georgia, serif' }}>I</i></button>
        <label className="color-wrap" title="Text colour"><input type="color" id="colorIn" defaultValue="#000000" /></label>
        <div className="sep"></div>
        <button className="btn" id="delBtn" disabled title="Delete selected (Del)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
          <span>Delete</span>
        </button>
        <span className="hint" id="hint">Click anywhere on a page to add text.</span>
      </div>

      <main id="viewer" className="tool-text">
        <div id="pages"></div>
        <div id="empty">
          <div className="drop" id="drop">
            <div className="doc-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M9 14h6M12 11v6" /></svg>
            </div>
            <h1>Edit a PDF in your browser</h1>
            <p>Add text, cover up existing content and insert images.<br />Your file never leaves this page.</p>
            <button className="btn primary big" id="uploadBtn">Upload PDF file</button>
            <div>
              or drop a PDF here · <button className="linkish" id="blankBtn">start with a blank page</button>
            </div>
            <div className="features">
              <span>✓ Fonts, sizes &amp; colours</span>
              <span>✓ Whiteout</span>
              <span>✓ Images &amp; signatures</span>
              <span>✓ Undo / redo</span>
            </div>
          </div>
        </div>
      </main>

      <input type="file" id="fileIn" accept="application/pdf,.pdf" className="hidden" />
      <input type="file" id="imgIn" accept="image/*" className="hidden" />
      <div id="toast"></div>
      <div id="busy">Working…</div>
    </div>
  );
}
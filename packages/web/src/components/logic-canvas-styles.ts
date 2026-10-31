import { css } from 'lit';
export const logicCanvasStyles = css`
  :host {
    display: block;
    height: 100%;
    min-height: 0;
    color: var(--p2b-fg);
    background: var(--p2b-bg);
  }
  * {
    box-sizing: border-box;
  }
  button,
  input,
  select,
  textarea {
    font: inherit;
    color: inherit;
    background: var(--p2b-bg);
    border: 1px solid var(--p2b-line);
    border-radius: 0;
    min-height: 28px;
  }
  button {
    cursor: pointer;
    padding: 3px 8px;
  }
  button:hover,
  button:focus-visible {
    border-color: var(--p2b-focus);
  }
  button:disabled {
    color: var(--p2b-dim);
    cursor: default;
  }
  button::before,
  button::after {
    content: none;
  }
  .library {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .library .library-category {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 10px;
  }
  .library-options {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .library .library-option {
    padding: 10px;
    white-space: normal;
  }
  .library-option-label { display: block; margin-bottom: 8px; }
  .library-preview {
    display: block;
    border: 1px solid var(--p2b-fg);
    color: var(--p2b-fg);
    background: var(--p2b-bg);
    text-align: left;
  }
  .preview-title, .preview-summary, .preview-description {
    display: block;
    overflow-wrap: anywhere;
  }
  .preview-title { padding: 6px; border-bottom: 1px solid var(--p2b-line); font-weight: bold; }
  .preview-summary { padding: 6px; }
  .preview-description { margin-top: 8px; line-height: 1.6; }
  .library-pager { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding-top: 8px; }
  .library .library-pager button { width: auto; margin: 0; }
  .library-pager span { white-space: nowrap; }
  .canvas-context-menu {
    position: fixed;
    z-index: 100;
    width: 250px;
    max-width: calc(100vw - 16px);
    padding: 4px;
    border: 1px solid var(--p2b-fg);
    background: var(--p2b-bg);
  }
  .menu-title { padding: 4px 8px; border-bottom: 1px solid var(--p2b-line); color: var(--p2b-dim); }
  .canvas-context-menu button { display: flex; justify-content: space-between; gap: 12px; width: 100%; border: 0; padding: 8px; }
  .canvas-context-menu button span { opacity: 0.7; }
  .canvas-context-menu button:focus-visible { outline: 1px solid var(--p2b-focus); outline-offset: -1px; }
  .workspace {
    height: 100%;
    min-height: 400px;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px;
    border-bottom: 1px solid var(--p2b-line);
    align-items: center;
  }
  .toolbar .status {
    margin-left: auto;
    color: var(--p2b-dim);
  }
  .body {
    display: grid;
    grid-template-columns: 280px minmax(260px, 1fr) 246px;
    min-height: 0;
  }
  aside {
    overflow: auto;
    padding: 10px;
  }
  .library {
    border-right: 1px solid var(--p2b-line);
  }
  .inspector {
    border-left: 1px solid var(--p2b-line);
  }
  h3 {
    font-size: inherit;
    margin: 6px 0 10px;
    color: var(--p2b-dim);
  }
  .library button {
    display: block;
    width: 100%;
    text-align: left;
    margin-bottom: 6px;
  }
  .library p,
  .hint {
    color: var(--p2b-dim);
    font-size: inherit;
    line-height: 1.7;
  }
  .stage {
    position: relative;
    overflow: clip;
    min-width: 0;
    min-height: 0;
    touch-action: none;
    outline: none;
  }
  .stage.panning, .stage.panning * {
    cursor: grabbing !important;
  }
  .grid {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .surface {
    transform-origin: 0 0;
    position: absolute;
    inset: 0;
    min-width: 100%;
    min-height: 100%;
  }
  .wires {
    position: absolute;
    inset: 0;
    overflow: visible;
    pointer-events: none;
  }
  .reference-wires { z-index: 0; }
  .flow-wires { z-index: 1000; }
  .logic-layer {
    position: absolute;
    inset: 0;
    isolation: isolate;
    pointer-events: none;
  }
  .logic-layer > .node,
  .logic-layer > .envelope,
  .logic-layer > .relation,
  .logic-layer .port,
  .logic-layer .envelope-header {
    pointer-events: auto;
  }
  .reference-wires .edge-hit { stroke-width: 22; }
  .flow-line {
    stroke: var(--p2b-fg);
    stroke-width: 1.5;
    fill: none;
  }
  .reference-line {
    stroke: var(--p2b-info, #55ffff);
    stroke-width: 1;
    fill: none;
  }
  .edge-hit {
    pointer-events: stroke;
    stroke: transparent;
    stroke-width: 14;
    fill: none;
    cursor: pointer;
  }
  .edge-selected {
    stroke: var(--p2b-focus);
  }
  .node {
    position: absolute;
    width: 180px;
    height: 76px;
    border: 1px solid var(--p2b-line);
    background: var(--p2b-bg);
    cursor: grab;
    user-select: none;
    padding: 9px 12px;
    z-index: 2;
  }
  .node:focus-visible,
  .node.selected {
    outline: 1px solid var(--p2b-focus);
    outline-offset: 3px;
  }
  .drag-member { outline: 1px dashed var(--p2b-focus); outline-offset: 3px; }
  .snap-feedback { color: var(--p2b-focus); }
  .cut-marker, .drag-cleanup { position: absolute; pointer-events: none; z-index: 10000; color: var(--p2b-focus); background: var(--p2b-bg); }
  .cut-marker { transform: translate(-50%, -50%); border: 1px dashed var(--p2b-focus); padding: 2px 5px; }
  .drag-cleanup { left: 0; top: 0; padding: 4px; }
  .node-title {
    font-weight: bold;
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .node-summary {
    display: block;
    color: var(--p2b-dim);
    margin-top: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: inherit;
  }
  .node[data-kind='branch'] { padding-right: 62px; }
  .port[aria-pressed='true'] { border-color: var(--p2b-focus); background: var(--p2b-focus); }
  .node[data-kind='variable'] {
    border-color: var(--p2b-info, #55ffff);
  }
  .node[data-kind='start'] {
    border-color: var(--p2b-ok, #55ff55);
  }
  .envelope {
    position: absolute;
    border: 1px dashed var(--p2b-dim);
    pointer-events: none;
  }
  .envelope.selected {
    border-color: var(--p2b-focus);
  }
  .envelope-summary {
    display: block;
    width: max-content;
    max-width: 100%;
    margin: -1px 5px 3px;
    height: 18px;
    line-height: 18px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--p2b-dim);
    background: var(--p2b-bg);
    pointer-events: auto;
  }
  .envelope-header {
    position: absolute;
    top: 6px;
    left: 8px;
    right: 8px;
    pointer-events: none;
  }
  .envelope-title {
    pointer-events: auto;
    display: block;
    width: max-content;
    background: var(--p2b-bg);
    cursor: grab;
    padding: 2px 5px;
    max-width: 100%;
    height: 26px;
    min-height: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .envelope-header .attachment {
    pointer-events: auto;
    display: block;
    width: 100%;
    height: 26px;
    min-height: 0;
    text-align: left;
    border: 0;
    padding: 2px 5px;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .attachment.selected { outline: 1px solid var(--p2b-focus); }
  .library-option { touch-action: none; user-select: none; cursor: grab; }
  .bend-handle {
    pointer-events: all;
    fill: var(--p2b-bg);
    stroke: var(--p2b-focus);
    stroke-width: 2;
    cursor: move;
  }
  .bend-handle.active { fill: var(--p2b-focus); }
  .port {
    pointer-events: auto;
    position: absolute;
    width: 12px;
    height: 12px;
    min-height: 0;
    padding: 0;
    border: 1px solid var(--p2b-fg);
    background: var(--p2b-bg);
    z-index: 3;
  }
  .port-in {
    left: -19px;
    top: 32px;
  }
  .port-out {
    right: -19px;
    top: 32px;
  }
  .port-then {
    right: -19px;
    top: 18px;
  }
  .port-else {
    right: -19px;
    top: 50px;
  }
  .port-label {
    position: absolute;
    right: 4px;
    font-size: inherit;
    color: var(--p2b-dim);
  }
  .then-label {
    top: 10px;
  }
  .else-label {
    top: 43px;
  }
  .relation {
    position: absolute;
    transform: translate(-50%, -50%);
    z-index: 4;
    min-width: 38px;
    min-height: 28px;
    border: 1px solid var(--p2b-info, #55ffff);
    padding: 2px 5px;
  }
  .relation.assignment {
    border-color: var(--p2b-caution, #ffff55);
  }
  .relation.selected {
    outline: 1px solid var(--p2b-focus);
    outline-offset: 2px;
  }
  .ghost {
    opacity: 0.35;
    pointer-events: none;
  }
  .snap-target {
    outline: 1px dashed var(--p2b-focus);
    outline-offset: 5px;
  }
  .attachment {
    color: var(--p2b-caution, #ffff55);
    font-size: inherit;
  }
  .marquee {
    position: absolute;
    border: 1px dashed var(--p2b-focus);
    pointer-events: none;
    z-index: 5;
  }
  label {
    display: block;
    margin: 10px 0;
    font-size: inherit;
    color: var(--p2b-dim);
  }
  label > input,
  label > select,
  label > textarea {
    display: block;
    width: 100%;
    margin-top: 5px;
    color: var(--p2b-fg);
    padding: 4px;
  }
  textarea {
    resize: vertical;
    min-height: 65px;
  }
  .inspector button {
    margin: 4px 4px 4px 0;
  }
  .inspector p {
    overflow-wrap: anywhere;
  }
  .feedback {
    border-top: 1px solid var(--p2b-line);
    max-height: 145px;
    overflow: auto;
    padding: 5px 10px;
    font-size: inherit;
  }
  .error {
    color: var(--p2b-error);
  }
  .feedback button {
    text-align: left;
    border: 0;
  }
  .steps {
    margin-top: 6px;
  }
  .steps table {
    border-collapse: collapse;
    width: 100%;
  }
  .steps td {
    border-top: 1px solid var(--p2b-line);
    padding: 4px;
  }
  @media (max-width: 1050px) {
    .body {
      grid-template-columns: 230px minmax(220px, 1fr) 195px;
    }
    aside {
      padding: 6px;
    }
  }
  @media (max-width: 760px) {
    .body {
      grid-template-columns: 210px minmax(200px, 1fr);
    }
    .inspector {
      grid-column: 1 / -1;
      max-height: 180px;
      border-top: 1px solid var(--p2b-line);
    }
  }
`;

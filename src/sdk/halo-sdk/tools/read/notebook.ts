/**
 * @module tools/read/notebook
 * Jupyter notebook (.ipynb) reader.
 * @license MIT
 */

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  outputs?: Array<{
    output_type: string;
    text?: string | string[];
    data?: Record<string, string | string[]>;
    traceback?: string[];
  }>;
}

interface Notebook {
  cells: NotebookCell[];
}

/**
 * Parse and format a Jupyter notebook for display.
 * Returns cells formatted as:
 *   [Cell N] (type):
 *   {source}
 *   [Output]:
 *   {output}
 */
export function formatNotebook(raw: string): string {
  const notebook: Notebook = JSON.parse(raw);

  if (!notebook.cells || !Array.isArray(notebook.cells)) {
    return '[Empty notebook or invalid format]';
  }

  const parts: string[] = [];

  for (let i = 0; i < notebook.cells.length; i++) {
    const cell = notebook.cells[i];
    const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');

    parts.push(`[Cell ${i}] (${cell.cell_type}):`);
    parts.push(source);

    // Format outputs for code cells
    if (cell.outputs && cell.outputs.length > 0) {
      const outputTexts: string[] = [];
      for (const output of cell.outputs) {
        if (output.text) {
          const text = Array.isArray(output.text) ? output.text.join('') : output.text;
          outputTexts.push(text);
        } else if (output.data) {
          // Prefer text/plain, then text/html
          const plain = output.data['text/plain'];
          if (plain) {
            outputTexts.push(Array.isArray(plain) ? plain.join('') : plain);
          }
        } else if (output.traceback) {
          outputTexts.push(output.traceback.join('\n'));
        }
      }
      if (outputTexts.length > 0) {
        parts.push('[Output]:');
        parts.push(outputTexts.join('\n'));
      }
    }

    parts.push(''); // blank line between cells
  }

  return parts.join('\n');
}

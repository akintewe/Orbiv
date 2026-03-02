/**
 * FocusBubble — fileConverter.ts  (Main Process)
 *
 * Converts dropped files to other formats.
 *
 * Supported conversions:
 *   DOCX / DOC / RTF / TXT / HTML → PDF, TXT, HTML, RTF, DOCX  (textutil)
 *   PNG / JPG / HEIC / TIFF / BMP / GIF / WEBP → any of those  (sips)
 *   PDF → TXT / HTML / RTF / DOCX                               (pdf-parse, pure JS)
 *
 * Every function returns a ConversionResult so the caller always gets a
 * structured response, never a thrown exception.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mammoth = require('mammoth') as { convertToHtml(opts: { path: string }): Promise<{ value: string }> };
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const exec = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConversionResult {
  ok: boolean;
  outputPath?: string;   // absolute path to the converted file (on success)
  message: string;       // human-readable status for the chat bubble
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Lower-cased extension without the dot, e.g. "docx" */
function ext(filePath: string): string {
  return path.extname(filePath).toLowerCase().replace('.', '');
}

/** Build an output path next to the source file, with a new extension */
function outputPath(inputPath: string, newExt: string): string {
  const dir  = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, `${base}.${newExt}`);
}


// ─── Tool availability checks ─────────────────────────────────────────────────

async function toolExists(tool: string): Promise<boolean> {
  try {
    await exec('which', [tool]);
    return true;
  } catch {
    return false;
  }
}

// ─── Converters ───────────────────────────────────────────────────────────────

/**
 * Convert document formats using macOS `textutil`.
 * Handles: docx, doc, rtf, html, txt, odt → txt, html, rtf, docx
 */
async function textutilConvert(
  inputPath: string,
  targetExt: 'txt' | 'html' | 'rtf' | 'docx',
): Promise<ConversionResult> {
  const out = outputPath(inputPath, targetExt);
  const formatFlag = targetExt === 'docx' ? 'docx' : targetExt;
  try {
    await exec('textutil', ['-convert', formatFlag, inputPath, '-output', out]);
    return { ok: true, outputPath: out, message: `Converted to ${targetExt.toUpperCase()} → saved next to original` };
  } catch (e) {
    return { ok: false, message: `textutil failed: ${(e as Error).message}` };
  }
}

/**
 * Convert a file using LibreOffice headless (soffice).
 * Works for DOCX, DOC, RTF, ODT, TXT, HTML, PPTX, XLSX, CSV, PDF.
 * Output lands in the same directory as the input file.
 */
async function libreofficeConvert(inputPath: string, targetExt = 'pdf'): Promise<ConversionResult> {
  if (!(await toolExists('soffice'))) {
    return {
      ok: false,
      message: 'LibreOffice is not installed. Install it from libreoffice.org to enable this conversion.',
    };
  }
  const outDir = path.dirname(inputPath);
  try {
    await exec('soffice', ['--headless', '--convert-to', targetExt, '--outdir', outDir, inputPath]);
    const expectedOut = outputPath(inputPath, targetExt);
    if (!fs.existsSync(expectedOut)) {
      return { ok: false, message: `LibreOffice ran but output .${targetExt} file not found.` };
    }
    return { ok: true, outputPath: expectedOut, message: `Converted to ${targetExt.toUpperCase()} → saved next to original` };
  } catch (e) {
    return { ok: false, message: `LibreOffice failed: ${(e as Error).message}` };
  }
}

/**
 * Convert image formats using macOS `sips` (Scriptable Image Processing System).
 * Supports: png, jpg/jpeg, heic, tiff, bmp, gif, webp (sips 2.0+)
 */
async function sipsConvert(
  inputPath: string,
  targetExt: string,
): Promise<ConversionResult> {
  const out = outputPath(inputPath, targetExt);
  // sips uses 'jpeg' not 'jpg'
  const format = targetExt === 'jpg' ? 'jpeg' : targetExt;
  try {
    await exec('sips', ['-s', 'format', format, inputPath, '--out', out]);
    return { ok: true, outputPath: out, message: `Converted to ${targetExt.toUpperCase()} → saved next to original` };
  } catch (e) {
    return { ok: false, message: `sips failed: ${(e as Error).message}` };
  }
}

/**
 * Convert a DOCX file to PDF using mammoth (HTML extraction) + pdf-lib.
 * Saves the output to ~/Downloads/<basename>.pdf.
 * No CLI tools or LibreOffice required.
 */
async function docxToPdf(inputPath: string): Promise<ConversionResult> {
  try {
    // Step 1: Extract text via mammoth (handles DOCX structure natively)
    const { value: html } = await mammoth.convertToHtml({ path: inputPath });

    // Strip HTML tags to get plain text paragraphs
    const plainText = html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .trim();

    // Step 2: Build PDF with pdf-lib
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const pageWidth = 595;   // A4 points
    const pageHeight = 842;
    const margin = 60;
    const lineHeight = 16;
    const fontSize = 11;
    const maxWidth = pageWidth - margin * 2;

    // Word-wrap a single line into multiple lines fitting maxWidth
    function wrapLine(line: string): string[] {
      const words = line.split(' ');
      const wrapped: string[] = [];
      let current = '';
      for (const word of words) {
        const test = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(test, fontSize) > maxWidth && current) {
          wrapped.push(current);
          current = word;
        } else {
          current = test;
        }
      }
      if (current) wrapped.push(current);
      return wrapped.length ? wrapped : [''];
    }

    // Build list of final rendered lines
    const allLines: string[] = [];
    for (const para of plainText.split('\n')) {
      if (para.trim() === '') {
        allLines.push('');
      } else {
        allLines.push(...wrapLine(para));
      }
    }

    // Paginate
    let page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    for (const line of allLines) {
      if (y < margin + lineHeight) {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
      if (line.trim()) {
        page.drawText(line, {
          x: margin, y,
          size: fontSize,
          font,
          color: rgb(0.05, 0.05, 0.05),
        });
      }
      y -= lineHeight;
    }

    // Step 3: Save to ~/Downloads
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outPath = path.join(downloadsDir, `${baseName}.pdf`);

    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(outPath, pdfBytes);

    return { ok: true, outputPath: outPath, message: `Converted to PDF → saved to Downloads` };
  } catch (e) {
    return { ok: false, message: `DOCX→PDF failed: ${(e as Error).message}` };
  }
}

/**
 * Extract text from a PDF using pdf-parse (pure JS, no binaries needed).
 * Then write it to TXT, HTML, RTF, or a minimal DOCX (Office Open XML).
 */
async function pdfConvert(inputPath: string, targetExt: string): Promise<ConversionResult> {
  try {
    const buf = fs.readFileSync(inputPath);
    const { text } = await pdfParse(buf);
    const out = outputPath(inputPath, targetExt);

    if (targetExt === 'txt') {
      fs.writeFileSync(out, text, 'utf8');
      return { ok: true, outputPath: out, message: 'Extracted text from PDF → saved as TXT next to original' };
    }

    if (targetExt === 'html') {
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const paragraphs = escaped.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
      const html = `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${path.basename(inputPath)}</title></head>\n<body>\n${paragraphs}\n</body></html>`;
      fs.writeFileSync(out, html, 'utf8');
      return { ok: true, outputPath: out, message: 'Converted PDF to HTML → saved next to original' };
    }

    if (targetExt === 'rtf') {
      const rtfText = text.replace(/\\/g, '\\\\').replace(/[{}]/g, c => `\\${c}`).replace(/\n/g, '\\par\n');
      const rtf = `{\\rtf1\\ansi\\deff0\n{\\fonttbl{\\f0 Helvetica;}}\n\\f0\\fs24\n${rtfText}\n}`;
      fs.writeFileSync(out, rtf, 'utf8');
      return { ok: true, outputPath: out, message: 'Converted PDF to RTF → saved next to original' };
    }

    if (targetExt === 'docx') {
      // Minimal Office Open XML DOCX — just paragraphs of plain text
      const paragraphs = text.split(/\n/).map(line => {
        const safe = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<w:p><w:r><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
      }).join('\n');

      const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
${paragraphs}
  </w:body>
</w:document>`;

      // Package root .rels
      const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

      // word/_rels/document.xml.rels (required by Word — can be empty of relationships)
      const wordRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;

      const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

      // Write to a temp dir then zip with correct relative paths (macOS `zip` always available)
      const tmpDir = path.join(os.tmpdir(), `focusbubble_docx_${Date.now()}`);
      fs.mkdirSync(path.join(tmpDir, '_rels'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'word', '_rels'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '[Content_Types].xml'), contentTypes);
      fs.writeFileSync(path.join(tmpDir, '_rels', '.rels'), rootRels);
      fs.writeFileSync(path.join(tmpDir, 'word', 'document.xml'), docXml);
      fs.writeFileSync(path.join(tmpDir, 'word', '_rels', 'document.xml.rels'), wordRels);

      if (fs.existsSync(out)) fs.unlinkSync(out);
      await exec('sh', ['-c', `cd "${tmpDir}" && zip -r "${out}" .`]);
      fs.rmSync(tmpDir, { recursive: true, force: true });

      return { ok: true, outputPath: out, message: 'Converted PDF to DOCX → saved next to original' };
    }

    return { ok: false, message: `Unknown target format: ${targetExt}` };
  } catch (e) {
    return { ok: false, message: `PDF conversion failed: ${(e as Error).message}` };
  }
}

// ─── Capability map ───────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'heic', 'tiff', 'tif', 'bmp', 'gif', 'webp']);
const DOC_EXTS   = new Set(['docx', 'doc', 'rtf', 'odt', 'txt', 'html', 'htm']);
const OFFICE_EXTS = new Set(['docx', 'doc', 'rtf', 'odt', 'txt', 'html', 'htm', 'pptx', 'xlsx', 'csv']);

/**
 * Return the list of formats a given file can be converted to.
 * Used by the renderer to suggest options in the chat.
 */
export function getSupportedTargets(filePath: string): string[] {
  const e = ext(filePath);

  if (IMAGE_EXTS.has(e)) {
    return [...IMAGE_EXTS].filter(f => f !== e && f !== 'tif');
  }

  if (DOC_EXTS.has(e)) {
    const targets: string[] = ['pdf'];
    if (e !== 'txt')  targets.push('txt');
    if (e !== 'html') targets.push('html');
    if (e !== 'rtf')  targets.push('rtf');
    if (e !== 'docx') targets.push('docx');
    return targets;
  }

  if (OFFICE_EXTS.has(e)) return ['pdf'];
  if (e === 'pdf') return ['docx', 'txt', 'html', 'rtf'];

  return [];
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Convert `inputPath` to `targetExt`.
 * Returns a ConversionResult — never throws.
 */
export async function convertFile(
  inputPath: string,
  targetExt: string,
): Promise<ConversionResult> {
  const srcExt = ext(inputPath);
  const target = targetExt.toLowerCase().replace('.', '');

  if (!fs.existsSync(inputPath)) {
    return { ok: false, message: `File not found: ${inputPath}` };
  }

  // ── Image → Image ──────────────────────────────────────────────────────────
  if (IMAGE_EXTS.has(srcExt) && IMAGE_EXTS.has(target)) {
    return sipsConvert(inputPath, target);
  }

  // ── DOCX → PDF (mammoth + pdf-lib, no external tools needed) ──────────────
  if (target === 'pdf' && ['docx', 'doc'].includes(srcExt)) {
    return docxToPdf(inputPath);
  }

  // ── Other office formats → PDF (LibreOffice if installed) ──────────────────
  if (target === 'pdf' && OFFICE_EXTS.has(srcExt)) {
    return libreofficeConvert(inputPath);
  }

  // ── PDF → TXT / HTML / RTF / DOCX (via pdf-parse, pure JS) ──────────────────
  if (srcExt === 'pdf' && ['txt', 'html', 'rtf', 'docx'].includes(target)) {
    return pdfConvert(inputPath, target);
  }

  // ── Document → text formats via textutil ──────────────────────────────────
  if (DOC_EXTS.has(srcExt) && ['txt', 'html', 'rtf', 'docx'].includes(target)) {
    return textutilConvert(inputPath, target as 'txt' | 'html' | 'rtf' | 'docx');
  }

  return {
    ok: false,
    message: `Can't convert .${srcExt} to .${target} — unsupported combination.`,
  };
}

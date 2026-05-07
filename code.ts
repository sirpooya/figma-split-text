// This plugin splits selected text nodes by a delimiter

// Escape special regex characters in delimiter
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Figma line breaks are not always `\n` — match common break sequences. */
const LINE_BREAK_RE = /\r\n|\n|\r|\u2028|\u2029|\u000B|\u000C|\u0085/g;

function textHasLineBreaks(s: string): boolean {
  return /\r\n|\n|\r|\u2028|\u2029|\u000B|\u000C|\u0085/.test(s);
}

type TextSegment = { value: string; start: number; end: number };

function lineSplitSegments(fullText: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lineStart = 0;
  const re = new RegExp(LINE_BREAK_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullText)) !== null) {
    const lineEnd = m.index;
    if (lineEnd > lineStart) {
      segments.push({ value: fullText.slice(lineStart, lineEnd), start: lineStart, end: lineEnd });
    }
    lineStart = re.lastIndex;
  }
  if (lineStart < fullText.length) {
    segments.push({ value: fullText.slice(lineStart), start: lineStart, end: fullText.length });
  }
  return segments;
}

/** Split each logical line by `delimiter`, preserving absolute indices into `fullText`. */
function delimiterSegmentsLineFirst(fullText: string, delimiter: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const flushLine = (line: string, lineAbsStart: number) => {
    if (line.length === 0) {
      return;
    }
    if (!line.includes(delimiter)) {
      segments.push({ value: line, start: lineAbsStart, end: lineAbsStart + line.length });
      return;
    }
    const parts = line.split(delimiter);
    let pos = lineAbsStart;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.length > 0) {
        segments.push({ value: part, start: pos, end: pos + part.length });
      }
      if (i < parts.length - 1) {
        pos += part.length + delimiter.length;
      }
    }
  };

  let lineStart = 0;
  const re = new RegExp(LINE_BREAK_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullText)) !== null) {
    const line = fullText.slice(lineStart, m.index);
    flushLine(line, lineStart);
    lineStart = re.lastIndex;
  }
  flushLine(fullText.slice(lineStart), lineStart);
  return segments;
}

/** Single-line (or treat as blob): split by delimiter only. */
function delimiterSegmentsFlat(fullText: string, delimiter: string): TextSegment[] {
  if (!fullText.includes(delimiter)) {
    return [];
  }
  const segments: TextSegment[] = [];
  const parts = fullText.split(delimiter);
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.length > 0) {
      segments.push({ value: part, start: pos, end: pos + part.length });
    }
    if (i < parts.length - 1) {
      pos += part.length + delimiter.length;
    }
  }
  return segments;
}

function segmentsForSplit(
  fullText: string,
  delimiter: string,
  isLineSplit: boolean,
): TextSegment[] {
  if (isLineSplit) {
    return lineSplitSegments(fullText);
  }
  if (textHasLineBreaks(fullText)) {
    return delimiterSegmentsLineFirst(fullText, delimiter);
  }
  return delimiterSegmentsFlat(fullText, delimiter);
}

const DEFAULT_FONT: FontName = { family: 'Inter', style: 'Regular' };

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(label)), ms);
    }),
  ]);
}

async function loadFontOrFallback(font: FontName, ms: number): Promise<FontName> {
  try {
    await withTimeout(figma.loadFontAsync(font), ms, 'Font load timed out');
    return font;
  } catch {
    try {
      await withTimeout(figma.loadFontAsync(DEFAULT_FONT), ms, 'Fallback font load timed out');
    } catch {
      /* last resort */
    }
    return DEFAULT_FONT;
  }
}

/** True if the layer uses more than one font and/or font size over its full range. */
function textNodeHasMixedFontOrSize(node: TextNode): boolean {
  try {
    const len = node.characters.length;
    if (len <= 1) {
      return false;
    }
    if (node.getRangeFontName(0, len) === figma.mixed) {
      return true;
    }
    if (node.getRangeFontSize(0, len) === figma.mixed) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

type RangeRect = { x: number; y: number; width?: number; height?: number };

/** Map a vector from the text node's local space to a delta in its parent's space (rotation / scale only). */
function localDeltaToParent(node: SceneNode, lx: number, ly: number): { x: number; y: number } {
  const t = node.relativeTransform;
  return {
    x: t[0][0] * lx + t[0][1] * ly,
    y: t[1][0] * lx + t[1][1] * ly,
  };
}

function estimateLineHeightPx(node: TextNode, charIndex: number): number {
  const len = node.characters.length;
  const end = Math.min(charIndex + 1, len);
  if (charIndex >= len) {
    return typeof node.fontSize === 'number' ? node.fontSize * 1.2 : 16;
  }
  const lh = node.getRangeLineHeight(charIndex, end);
  if (lh !== figma.mixed && lh.unit === 'PIXELS') {
    return lh.value;
  }
  if (lh !== figma.mixed && lh.unit === 'PERCENT') {
    const fs = node.getRangeFontSize(charIndex, end);
    const fz = typeof fs === 'number' ? fs : (node.fontSize as number);
    return (lh.value / 100) * fz;
  }
  const fs = node.getRangeFontSize(charIndex, end);
  const fz = typeof fs === 'number' ? fs : (node.fontSize as number);
  return fz * 1.2;
}

/**
 * Use a runtime API if Figma exposes one (not always present in typings).
 * Rect is assumed to be in the text node's local coordinate space (origin = layer top-left).
 */
function tryNativeRangeRect(node: TextNode, start: number, end: number): RangeRect | null {
  const n = node as TextNode & {
    getRangeBoundingBox?: (s: number, e: number) => RangeRect;
    getRangeBounds?: (s: number, e: number) => RangeRect;
  };
  for (const method of ['getRangeBoundingBox', 'getRangeBounds'] as const) {
    const fn = n[method];
    if (typeof fn === 'function') {
      try {
        const r = fn.call(n, start, end);
        if (r && typeof r.x === 'number' && typeof r.y === 'number') {
          return r;
        }
      } catch (_e) {
        /* continue */
      }
    }
  }
  return null;
}

/**
 * Approximate (lx, ly) for the start of a character range using a hidden clone.
 * Accurate for LEFT- or JUSTIFIED-aligned text; line Y uses newline count × line height.
 */
function getSegmentLocalOffsetViaClone(source: TextNode, partStartIndex: number): { lx: number; ly: number } {
  try {
    const chars = source.characters;
    const prefix = chars.slice(0, partStartIndex);
    let lineStarts = 0;
    let lineCount = 0;
    const re = new RegExp(LINE_BREAK_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(prefix)) !== null) {
      lineCount++;
      lineStarts = m.index + m[0].length;
    }
    const lh = estimateLineHeightPx(source, partStartIndex);

    const probe = source.clone();
    probe.visible = false;
    figma.currentPage.appendChild(probe);
    try {
      probe.deleteCharacters(partStartIndex, chars.length);
      probe.deleteCharacters(0, lineStarts);
      probe.textAutoResize = 'WIDTH_AND_HEIGHT';
      const dx = probe.width;
      const dy = lineCount * lh;
      return { lx: dx, ly: dy };
    } finally {
      probe.remove();
    }
  } catch {
    return { lx: 0, ly: 0 };
  }
}

function applyPreservedSegmentPosition(
  source: TextNode,
  newNode: TextNode,
  partStartIndex: number,
  partEndIndex: number,
  originalX: number,
  originalY: number,
  stackVertically: boolean,
  fallbackY: number,
): void {
  if (stackVertically) {
    newNode.x = originalX;
    newNode.y = fallbackY;
    return;
  }

  const native = tryNativeRangeRect(source, partStartIndex, partEndIndex);
  if (native) {
    const d = localDeltaToParent(source, native.x, native.y);
    newNode.x = originalX + d.x;
    newNode.y = originalY + d.y;
    newNode.textAlignHorizontal = 'LEFT';
    newNode.textAlignVertical = 'TOP';
    return;
  }

  const align = source.textAlignHorizontal;
  const useWidthProbe = align === 'LEFT' || align === 'JUSTIFIED';
  if (useWidthProbe) {
    const off = getSegmentLocalOffsetViaClone(source, partStartIndex);
    const d = localDeltaToParent(source, off.lx, off.ly);
    newNode.x = originalX + d.x;
    newNode.y = originalY + d.y;
    newNode.textAlignHorizontal = 'LEFT';
    newNode.textAlignVertical = 'TOP';
    return;
  }

  newNode.x = originalX;
  newNode.y = fallbackY;
}

// Extract split logic into a reusable function
async function performSplit(delimiter: string, wrapInAutoLayout: boolean, stackVertically: boolean = false, isLineSplit: boolean = false) {
  const FONT_LOAD_MS = 8000;
  const SPLIT_TOTAL_MS = 45000;

  // Allow space and newline characters as valid delimiters
  // Check for null/undefined, but allow empty string and space character as valid delimiters
  if (delimiter === null || delimiter === undefined) {
    figma.notify('Please enter a delimiter');
    return;
  }

  const splitMaxEnd = Date.now() + SPLIT_TOTAL_MS;
  const checkTimeBudget = (): void => {
    if (Date.now() > splitMaxEnd) {
      throw new Error(
        'Split Text stopped: took too long. Try shorter text, fewer styles, or split in smaller chunks.',
      );
    }
  };

  const selection = figma.currentPage.selection;
  
  if (selection.length === 0) {
    figma.notify('Please select at least one text layer');
    return;
  }

  const textNodes = selection.filter(node => node.type === 'TEXT') as TextNode[];
  
  if (textNodes.length === 0) {
    figma.notify('Please select at least one text layer');
    return;
  }

  try {
  let totalSplit = 0;
  const allNewNodes: (TextNode | FrameNode)[] = [];

  const fontCache = new Map<string, FontName>();
  const fontsToLoad = new Set<string>();

  const rememberFont = (f: FontName): void => {
    const key = `${f.family}-${f.style}`;
    if (!fontCache.has(key)) {
      fontCache.set(key, f);
      fontsToLoad.add(key);
    }
  };

  rememberFont(DEFAULT_FONT);

  const collectFontsFromNode = (node: TextNode, maxChars: number, maxUnique: number): void => {
    const len = Math.min(node.characters.length, maxChars);
    for (let i = 0; i < len && fontsToLoad.size < maxUnique; i++) {
      try {
        const f = node.getRangeFontName(i, i + 1);
        if (f !== figma.mixed && f && typeof f === 'object' && 'family' in f && 'style' in f) {
          rememberFont(f as FontName);
        }
      } catch {
        /* skip */
      }
    }
  };

  for (const textNode of textNodes) {
    collectFontsFromNode(textNode, 8000, 80);
    checkTimeBudget();
  }

  for (const fontKey of fontsToLoad) {
    const fontName = fontCache.get(fontKey)!;
    try {
      checkTimeBudget();
      const loaded = await loadFontOrFallback(fontName, FONT_LOAD_MS);
      fontCache.set(fontKey, loaded);
    } catch {
      fontCache.set(fontKey, DEFAULT_FONT);
    }
  }
  
  // Process each text node
  for (const textNode of textNodes) {
    const originalText = textNode.characters;
    
    // Safety check for problematic text
    if (!originalText || originalText.length === 0 || originalText.length > 10000) {
      continue;
    }
    
    let segments: TextSegment[] = [];
    try {
      segments = segmentsForSplit(originalText, delimiter, isLineSplit);
    } catch (error) {
      // If segmentation fails, try simple split as fallback
      if (!isLineSplit && originalText.includes(delimiter)) {
        const parts = originalText.split(delimiter);
        segments = [];
        let pos = 0;
        for (const part of parts) {
          if (part.length > 0) {
            segments.push({ value: part, start: pos, end: pos + part.length });
          }
          pos += part.length + delimiter.length;
        }
      }
    }

    if (segments.length < 2) {
      continue;
    }

    const parent = textNode.parent;
    const originalX = textNode.x;
    const originalY = textNode.y;
    const baseFontSize = typeof textNode.fontSize === 'number' ? textNode.fontSize : 16;
    const textAlign = textNode.textAlignHorizontal;

    const hasMixedFormatting = textNodeHasMixedFontOrSize(textNode);

    let defaultFontName: FontName;
    try {
      if (originalText.length > 0) {
        const firstFont = textNode.getRangeFontName(0, 1);
        if (firstFont !== figma.mixed && firstFont && typeof firstFont === 'object' && 'family' in firstFont) {
          defaultFontName = firstFont as FontName;
        } else {
          defaultFontName = DEFAULT_FONT;
        }
      } else {
        defaultFontName = DEFAULT_FONT;
      }
    } catch {
      defaultFontName = DEFAULT_FONT;
    }

    let defaultFontKey = `${defaultFontName.family}-${defaultFontName.style}`;
    if (!fontCache.has(defaultFontKey)) {
      try {
        checkTimeBudget();
        const loaded = await loadFontOrFallback(defaultFontName, FONT_LOAD_MS);
        defaultFontName = loaded;
        defaultFontKey = `${loaded.family}-${loaded.style}`;
        fontCache.set(defaultFontKey, loaded);
      } catch {
        defaultFontName = DEFAULT_FONT;
        defaultFontKey = `${DEFAULT_FONT.family}-${DEFAULT_FONT.style}`;
        fontCache.set(defaultFontKey, DEFAULT_FONT);
      }
    }
    
    // Create new text nodes for each segment
    const newNodes: TextNode[] = [];
    let currentY = originalY;
    let segIndex = 0;
    
    for (const seg of segments) {
      if (segIndex % 25 === 0) {
        checkTimeBudget();
      }
      segIndex++;

      const part = seg.value;
      const partStartIndex = seg.start;
      const partEndIndex = seg.end;

      try {
        const newNode = figma.createText();
        
        newNode.fontName = fontCache.get(defaultFontKey) ?? defaultFontName;
        newNode.fontSize = baseFontSize;
        newNode.characters = part;
        
        // Apply styling from the original segment (with timeout protection)
        const applySegmentStyling = async () => {
          try {
            if (partStartIndex >= originalText.length || partEndIndex > originalText.length || partEndIndex <= partStartIndex) {
              return;
            }
            
            const segmentLength = Math.min(partEndIndex - partStartIndex, part.length, 500);

            for (let i = 0; i < segmentLength; i++) {
              if (i % 40 === 0) {
                checkTimeBudget();
              }
              const sourceIndex = partStartIndex + i;
              const targetIndex = i;
              
              if (sourceIndex >= originalText.length || targetIndex >= newNode.characters.length) {
                break;
              }
              
              try {
                // Font name and style (synchronously, no async loading)
                try {
                  const sourceFontName = textNode.getRangeFontName(sourceIndex, sourceIndex + 1);
                  if (sourceFontName !== figma.mixed && sourceFontName && typeof sourceFontName === 'object') {
                    newNode.setRangeFontName(targetIndex, targetIndex + 1, sourceFontName);
                  }
                } catch (e) { /* ignore */ }
                
                // Font size
                try {
                  const sourceFontSize = textNode.getRangeFontSize(sourceIndex, sourceIndex + 1);
                  if (typeof sourceFontSize === 'number') {
                    newNode.setRangeFontSize(targetIndex, targetIndex + 1, sourceFontSize);
                  }
                } catch (e) { /* ignore */ }
                
                // Text fills (colors)
                try {
                  const sourceFills = textNode.getRangeFills(sourceIndex, sourceIndex + 1);
                  if (sourceFills !== figma.mixed && Array.isArray(sourceFills)) {
                    newNode.setRangeFills(targetIndex, targetIndex + 1, sourceFills);
                  }
                } catch (e) { /* ignore */ }
                
                // Text decoration (underline, strikethrough)
                try {
                  const sourceTextDecoration = textNode.getRangeTextDecoration(sourceIndex, sourceIndex + 1);
                  if (sourceTextDecoration !== figma.mixed) {
                    newNode.setRangeTextDecoration(targetIndex, targetIndex + 1, sourceTextDecoration);
                  }
                } catch (e) { /* ignore */ }
                
                // Letter spacing
                try {
                  const sourceLetterSpacing = textNode.getRangeLetterSpacing(sourceIndex, sourceIndex + 1);
                  if (sourceLetterSpacing !== figma.mixed) {
                    newNode.setRangeLetterSpacing(targetIndex, targetIndex + 1, sourceLetterSpacing);
                  }
                } catch (e) { /* ignore */ }
                
                // Line height
                try {
                  const sourceLineHeight = textNode.getRangeLineHeight(sourceIndex, sourceIndex + 1);
                  if (sourceLineHeight !== figma.mixed) {
                    newNode.setRangeLineHeight(targetIndex, targetIndex + 1, sourceLineHeight);
                  }
                } catch (e) { /* ignore */ }
                
                // Text case
                try {
                  const sourceTextCase = textNode.getRangeTextCase(sourceIndex, sourceIndex + 1);
                  if (sourceTextCase !== figma.mixed) {
                    newNode.setRangeTextCase(targetIndex, targetIndex + 1, sourceTextCase);
                  }
                } catch (e) { /* ignore */ }
                
              } catch (e) {
                continue;
              }
            }
          } catch (error) {
            // Ignore all styling errors to prevent infinite loops
          }
        };
        
        // Copy per-character styling (fonts are preloaded; bounded loop + timeout avoids hangs)
        if (hasMixedFormatting) {
          checkTimeBudget();
        }
        try {
          await Promise.race([
            applySegmentStyling(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('Styling timeout')), hasMixedFormatting ? 1200 : 3000),
            ),
          ]);
        } catch {
          /* keep defaults */
        }

        if (textAlign) {
          newNode.textAlignHorizontal = textAlign;
        }
        
        // Only stack vertically for explicit line splits, not multiline character splits
        const shouldStackVertically = stackVertically && isLineSplit;
        
        applyPreservedSegmentPosition(
          textNode,
          newNode,
          partStartIndex,
          partEndIndex,
          originalX,
          originalY,
          shouldStackVertically,
          currentY,
        );
        
        if (shouldStackVertically) {
          currentY += newNode.height;
        }
        
        if (parent && (parent.type === 'FRAME' || parent.type === 'GROUP' || parent.type === 'SECTION' || parent.type === 'COMPONENT' || parent.type === 'INSTANCE')) {
          parent.appendChild(newNode);
        } else if (parent && 'appendChild' in parent) {
          parent.appendChild(newNode);
        } else {
          figma.currentPage.appendChild(newNode);
        }
        
        newNodes.push(newNode);
        allNewNodes.push(newNode);
      } catch (error) {
        // Continue with next segment on error
      }
    }
    
    // Remove the original node only if we created new ones
    if (newNodes.length > 0) {
      textNode.remove();
      
      // Wrap in Auto-Layout if requested
      if (wrapInAutoLayout && newNodes.length > 0) {
        const autoLayoutFrame = figma.createFrame();
        autoLayoutFrame.name = 'Text Split';
        // Use VERTICAL layout only for explicit line splits, HORIZONTAL for delimiter splits
        const useVerticalLayout = isLineSplit;
        autoLayoutFrame.layoutMode = useVerticalLayout ? 'VERTICAL' : 'HORIZONTAL';
        autoLayoutFrame.primaryAxisSizingMode = 'AUTO';
        autoLayoutFrame.counterAxisSizingMode = 'AUTO';
        autoLayoutFrame.paddingLeft = 0;
        autoLayoutFrame.paddingRight = 0;
        autoLayoutFrame.paddingTop = 0;
        autoLayoutFrame.paddingBottom = 0;
        autoLayoutFrame.itemSpacing = 0;
        autoLayoutFrame.fills = [];
        autoLayoutFrame.x = originalX;
        autoLayoutFrame.y = originalY;
        
        // Move all new nodes into the Auto-Layout frame
        for (const newNode of newNodes) {
          const currentParent = newNode.parent;
          if (currentParent && 'removeChild' in currentParent) {
            try {
              (currentParent as any).removeChild(newNode);
            } catch (e) {
              // Continue if removal fails
            }
          }
          autoLayoutFrame.appendChild(newNode);
        }
        
        // Add Auto-Layout frame to parent
        if (parent && (parent.type === 'FRAME' || parent.type === 'GROUP' || parent.type === 'SECTION' || parent.type === 'COMPONENT' || parent.type === 'INSTANCE')) {
          parent.appendChild(autoLayoutFrame);
        } else if (parent && 'appendChild' in parent) {
          parent.appendChild(autoLayoutFrame);
        } else {
          figma.currentPage.appendChild(autoLayoutFrame);
        }
        
        // Replace newNodes with frame in allNewNodes
        const frameIndex = allNewNodes.indexOf(newNodes[0]);
        if (frameIndex !== -1) {
          for (let i = 0; i < newNodes.length; i++) {
            const index = allNewNodes.indexOf(newNodes[i]);
            if (index !== -1) {
              allNewNodes.splice(index, 1);
            }
          }
          allNewNodes.push(autoLayoutFrame);
        }
      }
      
      totalSplit++;
    }
  }
  
  // Select all new nodes at the end
  if (allNewNodes.length > 0) {
    figma.currentPage.selection = allNewNodes;
    figma.notify(`Split ${totalSplit} text layer(s) into ${allNewNodes.length} new layer(s)`);
    if (figma.command === 'split-with' || figma.command === 'split-by-line') {
      figma.closePlugin();
    }
  } else {
    if (isLineSplit) {
      figma.notify(
        'No text layers were split. The text has no line breaks (only soft-wrapped lines). Use Enter for hard line breaks, or split by delimiter.',
      );
    } else {
      figma.notify('No text layers were split. Make sure the delimiter exists in the selected text.');
    }
  }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    figma.notify('Split Text: ' + message);
  }
}

// Handle parameter input for command palette
figma.parameters.on('input', ({ parameters, key, query, result }) => {
  if (key === 'delimiter') {
    result.setSuggestions([]);
  }
});

// Handle menu commands
figma.on('run', ({ command, parameters }) => {
  void (async () => {
    try {
      if (command === 'split-with' && parameters) {
        const delimiter = parameters.delimiter as string;
        const wrapInAutoLayout = false;

        if (delimiter && delimiter.length > 0) {
          await performSplit(delimiter, wrapInAutoLayout, false, false);
        } else {
          figma.notify('Please enter a delimiter');
          figma.closePlugin();
        }
      } else if (command === 'split-by-line') {
        await performSplit('\n', false, true, true);
      } else {
        figma.showUI(__html__, { width: 272, height: 188, themeColors: true });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      figma.notify('Split Text: ' + message);
    }
  })();
});

// Handle messages from the UI
figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === 'split-text') {
      const delimiter = msg.delimiter;
      const wrapInAutoLayout = (msg as any).wrapInAutoLayout || false;
      await performSplit(delimiter, wrapInAutoLayout, false, false);
    }
    
    if (msg.type === 'split-by-line') {
      const wrapInAutoLayout = (msg as any).wrapInAutoLayout || false;
      await performSplit('\n', wrapInAutoLayout, true, true);
    }
    
    if (msg.type === 'resize-ui') {
      const height = (msg as any).height as number;
      if (height && height > 0) {
        figma.ui.resize(272, height);
      }
    }
    
    if (msg.type === 'cancel') {
      figma.closePlugin();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    figma.notify('Split Text: ' + message);
  }
};

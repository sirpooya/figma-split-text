// This plugin splits selected text nodes by a delimiter

// Escape special regex characters in delimiter
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const chars = source.characters;
  const prefix = chars.slice(0, partStartIndex);
  const lineStarts = prefix.lastIndexOf('\n') + 1;
  const lineCount = (prefix.match(/\n/g) || []).length;
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
  // Allow space and newline characters as valid delimiters
  if (!delimiter || delimiter.length === 0) {
    figma.notify('Please enter a delimiter');
    return;
  }
  
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

  let totalSplit = 0;
  const allNewNodes: (TextNode | FrameNode)[] = [];
  
  // Pre-collect all unique fonts to batch load them
  const fontCache = new Map<string, FontName>();
  const fontsToLoad = new Set<string>();
  
  // First pass: collect all fonts that will be needed
  for (const textNode of textNodes) {
    const originalText = textNode.characters;
    if (!originalText.includes(delimiter)) continue;
    
    const parts = originalText.split(delimiter);
    if (parts.length < 2) continue;
    
    let currentTextIndex = 0;
    for (const part of parts) {
      if (part === '') {
        currentTextIndex += delimiter.length;
        continue;
      }
      
      try {
        const partStartIndex = currentTextIndex;
        if (partStartIndex < originalText.length) {
          const endIndex = Math.min(partStartIndex + 1, originalText.length);
          const fontName = textNode.getRangeFontName(partStartIndex, endIndex) as FontName;
          const fontKey = `${fontName.family}-${fontName.style}`;
          fontCache.set(fontKey, fontName);
          fontsToLoad.add(fontKey);
        }
      } catch (e) {
        // Use fallback
        const fallbackKey = 'Inter-Regular';
        if (!fontCache.has(fallbackKey)) {
          fontCache.set(fallbackKey, { family: 'Inter', style: 'Regular' });
          fontsToLoad.add(fallbackKey);
        }
      }
      
      currentTextIndex += part.length + delimiter.length;
    }
  }
  
  // Batch load all fonts upfront
  const fontLoadPromises: Promise<void>[] = [];
  for (const fontKey of fontsToLoad) {
    const fontName = fontCache.get(fontKey)!;
    fontLoadPromises.push(
      figma.loadFontAsync(fontName).catch(() => {
        // Try fallback if font fails
        const fallback = { family: 'Inter', style: 'Regular' };
        return figma.loadFontAsync(fallback);
      })
    );
  }
  
  await Promise.all(fontLoadPromises);
  
  // Process each text node
  for (const textNode of textNodes) {
    const originalText = textNode.characters;
    
    if (!originalText.includes(delimiter)) {
      continue;
    }
    
    const parts = originalText.split(delimiter);
    
    if (parts.length < 2) {
      continue;
    }

    const parent = textNode.parent;
    const originalX = textNode.x;
    const originalY = textNode.y;
    const fontSize = textNode.fontSize as number;
    const textAlign = textNode.textAlignHorizontal;
    const defaultTextStyle = textNode.textStyleId;
    const fills = textNode.fills;
    const letterSpacing = textNode.letterSpacing;
    const lineHeight = textNode.lineHeight;
    
    // Get default font
    let defaultFontName: FontName;
    try {
      if (originalText.length > 0) {
        defaultFontName = textNode.getRangeFontName(0, 1) as FontName;
      } else {
        defaultFontName = { family: 'Inter', style: 'Regular' };
      }
    } catch (error) {
      defaultFontName = { family: 'Inter', style: 'Regular' };
    }
    
    // Ensure default font is loaded
    const defaultFontKey = `${defaultFontName.family}-${defaultFontName.style}`;
    if (!fontCache.has(defaultFontKey)) {
      await figma.loadFontAsync(defaultFontName);
      fontCache.set(defaultFontKey, defaultFontName);
    }
    
    // Create new text nodes for each part
    const newNodes: TextNode[] = [];
    let currentTextIndex = 0;
    let currentY = originalY; // Track Y position for vertical stacking
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      
      if (part === '') {
        currentTextIndex += delimiter.length;
        continue;
      }
      
      try {
        const partStartIndex = currentTextIndex;
        
        // Get font and style for this part
        let partFontName: FontName = defaultFontName;
        let partTextStyle: string | undefined = defaultTextStyle ? (typeof defaultTextStyle === 'string' ? defaultTextStyle : undefined) : undefined;
        
        try {
          if (partStartIndex < originalText.length) {
            const endIndex = Math.min(partStartIndex + 1, originalText.length);
            partFontName = textNode.getRangeFontName(partStartIndex, endIndex) as FontName;
            const rangeTextStyle = textNode.getRangeTextStyleId(partStartIndex, endIndex);
            if (rangeTextStyle !== figma.mixed && typeof rangeTextStyle === 'string') {
              partTextStyle = rangeTextStyle;
            }
          }
        } catch (error) {
          // Use defaults
        }
        
        // Create new text node
        const newNode = figma.createText();
        
        // Font should already be loaded from batch loading
        const partFontKey = `${partFontName.family}-${partFontName.style}`;
        if (!fontCache.has(partFontKey)) {
          await figma.loadFontAsync(partFontName);
          fontCache.set(partFontKey, partFontName);
        }
        
        newNode.fontName = partFontName;
        newNode.fontSize = fontSize;
        newNode.characters = part;
        
        if (partTextStyle) {
          newNode.textStyleId = partTextStyle;
        }
        
        const partEndIndex = partStartIndex + part.length;
        currentTextIndex += part.length + delimiter.length;
        
        // Apply styling properties
        if (textAlign) {
          newNode.textAlignHorizontal = textAlign;
        }
        if (fills && Array.isArray(fills)) {
          newNode.fills = fills;
        }
        if (letterSpacing && typeof letterSpacing === 'object') {
          newNode.letterSpacing = letterSpacing;
        }
        if (lineHeight && typeof lineHeight === 'object') {
          newNode.lineHeight = lineHeight;
        }
        
        applyPreservedSegmentPosition(
          textNode,
          newNode,
          partStartIndex,
          partEndIndex,
          originalX,
          originalY,
          stackVertically,
          currentY,
        );
        
        // If stacking vertically (for split by line), increment Y position by text height
        if (stackVertically) {
          currentY += newNode.height;
        }
        
        // Add to parent
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
        // Continue with next part on error
      }
    }
    
    // Remove the original node only if we created new ones
    if (newNodes.length > 0) {
      textNode.remove();
      
      // Wrap in Auto-Layout if requested
      if (wrapInAutoLayout && newNodes.length > 0) {
        const autoLayoutFrame = figma.createFrame();
        autoLayoutFrame.name = 'Text Split';
        // Use VERTICAL layout for line splits, HORIZONTAL for delimiter splits
        autoLayoutFrame.layoutMode = isLineSplit ? 'VERTICAL' : 'HORIZONTAL';
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
      figma.notify('No text layers were split. The selected text does not contain newline characters.');
    } else {
      figma.notify('No text layers were split. Make sure the delimiter exists in the selected text.');
    }
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
  if (command === 'split-with' && parameters) {
    const delimiter = parameters.delimiter as string;
    const wrapInAutoLayout = false;
    
    if (delimiter && delimiter.length > 0) {
      performSplit(delimiter, wrapInAutoLayout, false, false);
    } else {
      figma.notify('Please enter a delimiter');
      figma.closePlugin();
    }
  } else if (command === 'split-by-line') {
    // Split by newline character with vertical stacking
    performSplit('\n', false, true, true);
  } else {
    figma.showUI(__html__, { width: 272, height: 188, themeColors: true });
  }
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
    figma.notify('Error: ' + (error as Error).message);
  }
};

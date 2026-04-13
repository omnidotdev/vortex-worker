/**
 * Built-in PDF Plugin
 *
 * PDF generation and parsing operations.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** PDF creation input */
interface CreateInput {
  /** Output file path */
  path: string;
  /** Page content (HTML or text blocks) */
  content?: string;
  /** Text blocks to add */
  textBlocks?: Array<{
    text: string;
    x: number;
    y: number;
    size?: number;
    font?: "helvetica" | "times" | "courier";
    color?: { r: number; g: number; b: number };
  }>;
  /** Images to embed */
  images?: Array<{
    path: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
  }>;
  /** Page size */
  pageSize?: "a4" | "letter" | "legal";
  /** Page orientation */
  orientation?: "portrait" | "landscape";
}

/** Parse PDF input */
interface ParseInput {
  /** PDF file path or URL */
  path: string;
  /** Extract specific pages (1-indexed) */
  pages?: number[];
  /** Extract images */
  extractImages?: boolean;
}

/** Merge PDFs input */
interface MergeInput {
  /** Input PDF paths */
  paths: string[];
  /** Output file path */
  outputPath: string;
}

/** Split PDF input */
interface SplitInput {
  /** Input PDF path */
  path: string;
  /** Output directory */
  outputDir: string;
  /** Split mode */
  mode: "all" | "ranges";
  /** Page ranges for 'ranges' mode (e.g., [[1,3], [4,6]]) */
  ranges?: [number, number][];
}

/** Add watermark input */
interface WatermarkInput {
  /** Input PDF path */
  path: string;
  /** Output PDF path */
  outputPath: string;
  /** Watermark text */
  text: string;
  /** Font size */
  fontSize?: number;
  /** Opacity (0-1) */
  opacity?: number;
  /** Rotation angle in degrees */
  rotation?: number;
  /** Color */
  color?: { r: number; g: number; b: number };
}

/** Extract pages input */
interface ExtractPagesInput {
  /** Input PDF path */
  path: string;
  /** Output PDF path */
  outputPath: string;
  /** Pages to extract (1-indexed) */
  pages: number[];
}

// Page dimensions in points (72 points per inch)
const PAGE_SIZES = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
  legal: { width: 612, height: 1008 },
};

/**
 * Create a new PDF with text and images.
 */
const create = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as CreateInput;
    const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");

    const pdfDoc = await PDFDocument.create();

    // Get page dimensions
    const size = PAGE_SIZES[input.pageSize ?? "a4"];
    const isLandscape = input.orientation === "landscape";
    const pageWidth = isLandscape ? size.height : size.width;
    const pageHeight = isLandscape ? size.width : size.height;

    const page = pdfDoc.addPage([pageWidth, pageHeight]);

    // Embed fonts
    const fonts = {
      helvetica: await pdfDoc.embedFont(StandardFonts.Helvetica),
      times: await pdfDoc.embedFont(StandardFonts.TimesRoman),
      courier: await pdfDoc.embedFont(StandardFonts.Courier),
    };

    // Add text blocks
    if (input.textBlocks) {
      for (const block of input.textBlocks) {
        const font = fonts[block.font ?? "helvetica"];
        const color = block.color
          ? rgb(block.color.r / 255, block.color.g / 255, block.color.b / 255)
          : rgb(0, 0, 0);

        page.drawText(block.text, {
          x: block.x,
          y: pageHeight - block.y, // PDF coordinates are from bottom-left.
          size: block.size ?? 12,
          font,
          color,
        });
      }
    }

    // Add simple content text
    if (input.content && !input.textBlocks) {
      const font = fonts.helvetica;
      const lines = input.content.split("\n");
      let y = pageHeight - 50;

      for (const line of lines) {
        if (y < 50) {
          // Add new page if needed
          const newPage = pdfDoc.addPage([pageWidth, pageHeight]);
          y = pageHeight - 50;
          newPage.drawText(line, { x: 50, y, size: 12, font });
        } else {
          page.drawText(line, { x: 50, y, size: 12, font });
        }
        y -= 14;
      }
    }

    // Add images
    if (input.images) {
      for (const img of input.images) {
        const imageFile = Bun.file(img.path);
        const imageBytes = await imageFile.arrayBuffer();
        const imageData = new Uint8Array(imageBytes);

        let image: Awaited<ReturnType<typeof pdfDoc.embedPng>>;
        if (img.path.toLowerCase().endsWith(".png")) {
          image = await pdfDoc.embedPng(imageData);
        } else {
          image = await pdfDoc.embedJpg(imageData);
        }

        const dims = image.scale(1);
        const width = img.width ?? dims.width;
        const height = img.height ?? dims.height;

        page.drawImage(image, {
          x: img.x,
          y: pageHeight - img.y - height,
          width,
          height,
        });
      }
    }

    const pdfBytes = await pdfDoc.save();
    await Bun.write(input.path, pdfBytes);

    return {
      success: true,
      output: {
        path: input.path,
        pageCount: pdfDoc.getPageCount(),
        size: pdfBytes.length,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Parse PDF and extract text.
 */
const parse = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ParseInput;
    const pdfParse = (await import("pdf-parse")).default;

    const file = Bun.file(input.path);
    const buffer = Buffer.from(await file.arrayBuffer());

    const options: { pagerender?: (pageData: unknown) => string } = {};

    // Custom page renderer if specific pages requested
    if (input.pages && input.pages.length > 0) {
      const targetPages = new Set(input.pages);
      options.pagerender = (pageData: unknown) => {
        const pd = pageData as { pageIndex: number };
        if (!targetPages.has(pd.pageIndex + 1)) {
          return "";
        }
        return (
          pageData as {
            getTextContent: () => Promise<{ items: Array<{ str: string }> }>;
          }
        )
          .getTextContent()
          .then((textContent) =>
            textContent.items.map((item) => item.str).join(" "),
          ) as unknown as string;
      };
    }

    const data = await pdfParse(buffer, options);

    return {
      success: true,
      output: {
        text: data.text,
        pageCount: data.numpages,
        info: data.info,
        metadata: data.metadata,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Merge multiple PDFs into one.
 */
const merge = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as MergeInput;
    const { PDFDocument } = await import("pdf-lib");

    const mergedPdf = await PDFDocument.create();

    for (const pdfPath of input.paths) {
      const file = Bun.file(pdfPath);
      const pdfBytes = await file.arrayBuffer();
      const pdf = await PDFDocument.load(pdfBytes);
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      for (const page of pages) {
        mergedPdf.addPage(page);
      }
    }

    const pdfBytes = await mergedPdf.save();
    await Bun.write(input.outputPath, pdfBytes);

    return {
      success: true,
      output: {
        path: input.outputPath,
        pageCount: mergedPdf.getPageCount(),
        mergedFiles: input.paths.length,
        size: pdfBytes.length,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Split PDF into multiple files.
 */
const split = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as SplitInput;
    const { PDFDocument } = await import("pdf-lib");
    const { mkdir } = await import("node:fs/promises");

    await mkdir(input.outputDir, { recursive: true });

    const file = Bun.file(input.path);
    const pdfBytes = await file.arrayBuffer();
    const pdf = await PDFDocument.load(pdfBytes);
    const pageCount = pdf.getPageCount();

    const outputFiles: string[] = [];

    if (input.mode === "all") {
      // Split into individual pages
      for (let i = 0; i < pageCount; i++) {
        const newPdf = await PDFDocument.create();
        const [page] = await newPdf.copyPages(pdf, [i]);
        newPdf.addPage(page);

        const outputPath = `${input.outputDir}/page_${i + 1}.pdf`;
        const bytes = await newPdf.save();
        await Bun.write(outputPath, bytes);
        outputFiles.push(outputPath);
      }
    } else if (input.mode === "ranges" && input.ranges) {
      // Split by ranges
      for (let rangeIdx = 0; rangeIdx < input.ranges.length; rangeIdx++) {
        const [start, end] = input.ranges[rangeIdx];
        const newPdf = await PDFDocument.create();

        const pageIndices: number[] = [];
        for (let i = start - 1; i < end && i < pageCount; i++) {
          pageIndices.push(i);
        }

        const pages = await newPdf.copyPages(pdf, pageIndices);
        for (const page of pages) {
          newPdf.addPage(page);
        }

        const outputPath = `${input.outputDir}/pages_${start}-${end}.pdf`;
        const bytes = await newPdf.save();
        await Bun.write(outputPath, bytes);
        outputFiles.push(outputPath);
      }
    }

    return {
      success: true,
      output: {
        files: outputFiles,
        fileCount: outputFiles.length,
        originalPageCount: pageCount,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Add watermark to PDF.
 */
const watermark = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as WatermarkInput;
    const { PDFDocument, rgb, StandardFonts, degrees } = await import(
      "pdf-lib"
    );

    const file = Bun.file(input.path);
    const pdfBytes = await file.arrayBuffer();
    const pdfDoc = await PDFDocument.load(pdfBytes);

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = input.fontSize ?? 50;
    const opacity = input.opacity ?? 0.3;
    const rotation = input.rotation ?? 45;
    const color = input.color
      ? rgb(input.color.r / 255, input.color.g / 255, input.color.b / 255)
      : rgb(0.5, 0.5, 0.5);

    const pages = pdfDoc.getPages();

    for (const page of pages) {
      const { width, height } = page.getSize();
      const textWidth = font.widthOfTextAtSize(input.text, fontSize);

      page.drawText(input.text, {
        x: (width - textWidth) / 2,
        y: height / 2,
        size: fontSize,
        font,
        color,
        opacity,
        rotate: degrees(rotation),
      });
    }

    const outputBytes = await pdfDoc.save();
    await Bun.write(input.outputPath, outputBytes);

    return {
      success: true,
      output: {
        path: input.outputPath,
        pageCount: pages.length,
        size: outputBytes.length,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Extract specific pages from PDF.
 */
const extractPages = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ExtractPagesInput;
    const { PDFDocument } = await import("pdf-lib");

    const file = Bun.file(input.path);
    const pdfBytes = await file.arrayBuffer();
    const pdf = await PDFDocument.load(pdfBytes);

    const newPdf = await PDFDocument.create();

    // Convert 1-indexed to 0-indexed
    const pageIndices = input.pages
      .map((p) => p - 1)
      .filter((i) => i >= 0 && i < pdf.getPageCount());

    const pages = await newPdf.copyPages(pdf, pageIndices);
    for (const page of pages) {
      newPdf.addPage(page);
    }

    const outputBytes = await newPdf.save();
    await Bun.write(input.outputPath, outputBytes);

    return {
      success: true,
      output: {
        path: input.outputPath,
        extractedPages: pageIndices.length,
        size: outputBytes.length,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Get PDF metadata and info.
 */
const info = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as { path: string };
    const { PDFDocument } = await import("pdf-lib");

    const file = Bun.file(input.path);
    const pdfBytes = await file.arrayBuffer();
    const pdfDoc = await PDFDocument.load(pdfBytes);

    const pages = pdfDoc.getPages();
    const pageInfo = pages.map((page, i) => {
      const { width, height } = page.getSize();
      return { page: i + 1, width, height };
    });

    return {
      success: true,
      output: {
        pageCount: pdfDoc.getPageCount(),
        title: pdfDoc.getTitle(),
        author: pdfDoc.getAuthor(),
        subject: pdfDoc.getSubject(),
        keywords: pdfDoc.getKeywords(),
        creator: pdfDoc.getCreator(),
        producer: pdfDoc.getProducer(),
        creationDate: pdfDoc.getCreationDate()?.toISOString(),
        modificationDate: pdfDoc.getModificationDate()?.toISOString(),
        pages: pageInfo,
        size: pdfBytes.byteLength,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * PDF built-in plugin definition.
 */
export const pdfPlugin: BuiltinPlugin = {
  id: "builtin:pdf",
  name: "PDF",
  description: "PDF generation, parsing, and manipulation",
  actions: {
    create: {
      name: "create",
      description: "Create a new PDF with text and images",
      handler: create,
    },
    parse: {
      name: "parse",
      description: "Parse PDF and extract text",
      handler: parse,
    },
    merge: {
      name: "merge",
      description: "Merge multiple PDFs into one",
      handler: merge,
    },
    split: {
      name: "split",
      description: "Split PDF into multiple files",
      handler: split,
    },
    watermark: {
      name: "watermark",
      description: "Add watermark to PDF",
      handler: watermark,
    },
    extractPages: {
      name: "extractPages",
      description: "Extract specific pages from PDF",
      handler: extractPages,
    },
    info: {
      name: "info",
      description: "Get PDF metadata and info",
      handler: info,
    },
  },
};

/**
 * Built-in Image Plugin
 *
 * Image manipulation operations: resize, crop, convert, optimize.
 * Uses sharp for image processing.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Resize input */
interface ResizeInput {
  /** Input image path or buffer */
  input: string;
  /** Output path */
  output: string;
  /** Target width */
  width?: number;
  /** Target height */
  height?: number;
  /** Fit mode */
  fit?: "cover" | "contain" | "fill" | "inside" | "outside";
  /** Background color for contain mode (hex or named color) */
  background?: string;
  /** Output format */
  format?: "jpeg" | "png" | "webp" | "avif" | "gif" | "tiff";
  /** Quality (1-100) */
  quality?: number;
}

/** Crop input */
interface CropInput {
  /** Input image path */
  input: string;
  /** Output path */
  output: string;
  /** Left offset */
  left: number;
  /** Top offset */
  top: number;
  /** Crop width */
  width: number;
  /** Crop height */
  height: number;
}

/** Convert input */
interface ConvertInput {
  /** Input image path */
  input: string;
  /** Output path */
  output: string;
  /** Target format */
  format: "jpeg" | "png" | "webp" | "avif" | "gif" | "tiff";
  /** Quality (1-100) */
  quality?: number;
}

/** Optimize input */
interface OptimizeInput {
  /** Input image path */
  input: string;
  /** Output path (defaults to overwriting input) */
  output?: string;
  /** Target quality (1-100) */
  quality?: number;
  /** Strip metadata */
  stripMetadata?: boolean;
}

/** Watermark input */
interface WatermarkInput {
  /** Input image path */
  input: string;
  /** Output path */
  output: string;
  /** Watermark image path or text */
  watermark: string;
  /** Is watermark text instead of image */
  isText?: boolean;
  /** Position */
  position?:
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right"
    | "center";
  /** Opacity (0-1) */
  opacity?: number;
  /** Margin from edge */
  margin?: number;
}

/** Rotate input */
interface RotateInput {
  /** Input image path */
  input: string;
  /** Output path */
  output: string;
  /** Rotation angle in degrees */
  angle: number;
  /** Background color for exposed corners */
  background?: string;
}

/** Flip input */
interface FlipInput {
  /** Input image path */
  input: string;
  /** Output path */
  output: string;
  /** Flip direction */
  direction: "horizontal" | "vertical" | "both";
}

/** Info input */
interface InfoInput {
  /** Image path */
  input: string;
}

/** Composite input */
interface CompositeInput {
  /** Base image path */
  input: string;
  /** Output path */
  output: string;
  /** Images to composite */
  layers: Array<{
    input: string;
    left?: number;
    top?: number;
    blend?: "over" | "multiply" | "screen" | "overlay";
  }>;
}

/**
 * Parse color string to RGB.
 */
const parseColor = (color: string): { r: number; g: number; b: number } => {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    if (hex.length === 3) {
      return {
        r: Number.parseInt(hex[0] + hex[0], 16),
        g: Number.parseInt(hex[1] + hex[1], 16),
        b: Number.parseInt(hex[2] + hex[2], 16),
      };
    }
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
    };
  }

  // Named colors.
  const colors: Record<string, { r: number; g: number; b: number }> = {
    white: { r: 255, g: 255, b: 255 },
    black: { r: 0, g: 0, b: 0 },
    red: { r: 255, g: 0, b: 0 },
    green: { r: 0, g: 255, b: 0 },
    blue: { r: 0, g: 0, b: 255 },
    transparent: { r: 0, g: 0, b: 0 },
  };

  return colors[color.toLowerCase()] ?? { r: 255, g: 255, b: 255 };
};

/**
 * Resize an image.
 */
const resize = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ResizeInput;
    const sharp = (await import("sharp")).default;

    let image = sharp(input.input);

    const resizeOptions: {
      width?: number;
      height?: number;
      fit?: "cover" | "contain" | "fill" | "inside" | "outside";
      background?: { r: number; g: number; b: number };
    } = {
      width: input.width,
      height: input.height,
      fit: input.fit ?? "cover",
    };

    if (input.background) {
      resizeOptions.background = parseColor(input.background);
    }

    image = image.resize(resizeOptions);

    // Convert format if specified.
    if (input.format) {
      image = image.toFormat(input.format, { quality: input.quality ?? 80 });
    }

    const outputBuffer = await image.toBuffer();
    await Bun.write(input.output, outputBuffer);

    const metadata = await sharp(outputBuffer).metadata();

    return {
      success: true,
      output: {
        path: input.output,
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        size: outputBuffer.length,
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
 * Crop an image.
 */
const crop = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as CropInput;
    const sharp = (await import("sharp")).default;

    const outputBuffer = await sharp(input.input)
      .extract({
        left: input.left,
        top: input.top,
        width: input.width,
        height: input.height,
      })
      .toBuffer();

    await Bun.write(input.output, outputBuffer);

    return {
      success: true,
      output: {
        path: input.output,
        width: input.width,
        height: input.height,
        size: outputBuffer.length,
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
 * Convert image format.
 */
const convert = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ConvertInput;
    const sharp = (await import("sharp")).default;

    const outputBuffer = await sharp(input.input)
      .toFormat(input.format, { quality: input.quality ?? 80 })
      .toBuffer();

    await Bun.write(input.output, outputBuffer);

    const metadata = await sharp(outputBuffer).metadata();

    return {
      success: true,
      output: {
        path: input.output,
        format: input.format,
        width: metadata.width,
        height: metadata.height,
        size: outputBuffer.length,
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
 * Optimize an image.
 */
const optimize = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as OptimizeInput;
    const sharp = (await import("sharp")).default;

    const originalFile = Bun.file(input.input);
    const originalSize = originalFile.size;

    let image = sharp(input.input);

    if (input.stripMetadata) {
      image = image.withMetadata({ orientation: undefined });
    }

    const metadata = await image.metadata();
    const format = metadata.format ?? "jpeg";
    const quality = input.quality ?? 80;

    // Apply format-specific optimization.
    if (format === "jpeg") {
      image = image.jpeg({ quality, mozjpeg: true });
    } else if (format === "png") {
      image = image.png({ quality, compressionLevel: 9 });
    } else if (format === "webp") {
      image = image.webp({ quality });
    }

    const outputBuffer = await image.toBuffer();
    const outputPath = input.output ?? input.input;
    await Bun.write(outputPath, outputBuffer);

    return {
      success: true,
      output: {
        path: outputPath,
        originalSize,
        optimizedSize: outputBuffer.length,
        savings: originalSize - outputBuffer.length,
        savingsPercent: Math.round(
          (1 - outputBuffer.length / originalSize) * 100,
        ),
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
 * Add watermark to image.
 */
const watermark = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as WatermarkInput;
    const sharp = (await import("sharp")).default;

    const baseImage = sharp(input.input);
    const baseMetadata = await baseImage.metadata();
    const baseWidth = baseMetadata.width ?? 0;
    const baseHeight = baseMetadata.height ?? 0;

    let watermarkBuffer: Buffer;

    if (input.isText) {
      // Create text watermark using SVG.
      const fontSize = 48;
      const svg = `
        <svg width="${baseWidth}" height="${baseHeight}">
          <text x="50%" y="50%" font-size="${fontSize}" fill="white" fill-opacity="${input.opacity ?? 0.5}"
            text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif">
            ${input.watermark}
          </text>
        </svg>
      `;
      watermarkBuffer = Buffer.from(svg);
    } else {
      const watermarkImage = sharp(input.watermark);
      watermarkBuffer = await watermarkImage.toBuffer();
    }

    // Calculate position.
    const margin = input.margin ?? 20;
    const watermarkMetadata = input.isText
      ? { width: baseWidth, height: baseHeight }
      : await sharp(watermarkBuffer).metadata();
    const wmWidth = watermarkMetadata.width ?? 0;
    const wmHeight = watermarkMetadata.height ?? 0;

    let left = margin;
    let top = margin;

    switch (input.position ?? "bottom-right") {
      case "top-left":
        left = margin;
        top = margin;
        break;
      case "top-right":
        left = baseWidth - wmWidth - margin;
        top = margin;
        break;
      case "bottom-left":
        left = margin;
        top = baseHeight - wmHeight - margin;
        break;
      case "bottom-right":
        left = baseWidth - wmWidth - margin;
        top = baseHeight - wmHeight - margin;
        break;
      case "center":
        left = Math.floor((baseWidth - wmWidth) / 2);
        top = Math.floor((baseHeight - wmHeight) / 2);
        break;
    }

    const outputBuffer = await baseImage
      .composite([
        {
          input: watermarkBuffer,
          left: Math.max(0, left),
          top: Math.max(0, top),
        },
      ])
      .toBuffer();

    await Bun.write(input.output, outputBuffer);

    return {
      success: true,
      output: {
        path: input.output,
        size: outputBuffer.length,
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
 * Rotate an image.
 */
const rotate = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as RotateInput;
    const sharp = (await import("sharp")).default;

    const rotateOptions: { background?: { r: number; g: number; b: number } } =
      {};

    if (input.background) {
      rotateOptions.background = parseColor(input.background);
    }

    const outputBuffer = await sharp(input.input)
      .rotate(input.angle, rotateOptions)
      .toBuffer();

    await Bun.write(input.output, outputBuffer);

    const metadata = await sharp(outputBuffer).metadata();

    return {
      success: true,
      output: {
        path: input.output,
        width: metadata.width,
        height: metadata.height,
        size: outputBuffer.length,
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
 * Flip an image.
 */
const flip = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as FlipInput;
    const sharp = (await import("sharp")).default;

    let image = sharp(input.input);

    if (input.direction === "horizontal" || input.direction === "both") {
      image = image.flop();
    }
    if (input.direction === "vertical" || input.direction === "both") {
      image = image.flip();
    }

    const outputBuffer = await image.toBuffer();
    await Bun.write(input.output, outputBuffer);

    return {
      success: true,
      output: {
        path: input.output,
        size: outputBuffer.length,
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
 * Get image metadata.
 */
const info = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as InfoInput;
    const sharp = (await import("sharp")).default;

    const image = sharp(input.input);
    const metadata = await image.metadata();
    const stats = await image.stats();

    const file = Bun.file(input.input);

    return {
      success: true,
      output: {
        path: input.input,
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        space: metadata.space,
        channels: metadata.channels,
        depth: metadata.depth,
        density: metadata.density,
        hasAlpha: metadata.hasAlpha,
        orientation: metadata.orientation,
        size: file.size,
        isAnimated: (metadata.pages ?? 1) > 1,
        pages: metadata.pages,
        stats: {
          channels: stats.channels.map(
            (c: { min: number; max: number; mean: number }) => ({
              min: c.min,
              max: c.max,
              mean: c.mean,
            }),
          ),
          isOpaque: stats.isOpaque,
        },
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
 * Composite multiple images.
 */
const composite = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as CompositeInput;
    const sharp = (await import("sharp")).default;

    const compositeInputs = input.layers.map((layer) => ({
      input: layer.input,
      left: layer.left ?? 0,
      top: layer.top ?? 0,
      blend: layer.blend ?? "over",
    }));

    const outputBuffer = await sharp(input.input)
      .composite(
        compositeInputs as Parameters<ReturnType<typeof sharp>["composite"]>[0],
      )
      .toBuffer();

    await Bun.write(input.output, outputBuffer);

    const metadata = await sharp(outputBuffer).metadata();

    return {
      success: true,
      output: {
        path: input.output,
        width: metadata.width,
        height: metadata.height,
        size: outputBuffer.length,
        layers: input.layers.length,
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
 * Image built-in plugin definition.
 */
export const imagePlugin: BuiltinPlugin = {
  id: "builtin:image",
  name: "Image",
  description: "Image manipulation: resize, crop, convert, optimize",
  actions: {
    resize: {
      name: "resize",
      description: "Resize an image",
      handler: resize,
    },
    crop: {
      name: "crop",
      description: "Crop an image",
      handler: crop,
    },
    convert: {
      name: "convert",
      description: "Convert image format",
      handler: convert,
    },
    optimize: {
      name: "optimize",
      description: "Optimize an image for web",
      handler: optimize,
    },
    watermark: {
      name: "watermark",
      description: "Add watermark to image",
      handler: watermark,
    },
    rotate: {
      name: "rotate",
      description: "Rotate an image",
      handler: rotate,
    },
    flip: {
      name: "flip",
      description: "Flip an image",
      handler: flip,
    },
    info: {
      name: "info",
      description: "Get image metadata",
      handler: info,
    },
    composite: {
      name: "composite",
      description: "Composite multiple images",
      handler: composite,
    },
  },
};

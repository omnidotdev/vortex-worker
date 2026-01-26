/**
 * Built-in Spreadsheet Plugin
 *
 * Excel and CSV file operations with full read/write/formula support.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type SpreadsheetFormat = "xlsx" | "xls" | "csv" | "auto";

/** Base spreadsheet input */
interface SpreadsheetInput {
  /** File path or URL */
  path: string;
  /** File format (auto-detected if not specified) */
  format?: SpreadsheetFormat;
}

/** Read spreadsheet input */
interface ReadInput extends SpreadsheetInput {
  /** Sheet name or index (default: first sheet) */
  sheet?: string | number;
  /** Start row (1-indexed, default: 1) */
  startRow?: number;
  /** End row (default: all) */
  endRow?: number;
  /** Column range (e.g., "A:D" or ["A", "B", "C"]) */
  columns?: string | string[];
  /** Use first row as headers */
  headers?: boolean;
  /** Output format */
  outputFormat?: "json" | "array" | "records";
}

/** Write spreadsheet input */
interface WriteInput extends SpreadsheetInput {
  /** Data to write */
  data: unknown[][] | Record<string, unknown>[];
  /** Sheet name (default: "Sheet1") */
  sheet?: string;
  /** Start cell (default: "A1") */
  startCell?: string;
  /** Include headers from object keys */
  includeHeaders?: boolean;
  /** Overwrite existing file or append */
  mode?: "overwrite" | "append";
}

/** Cell operation input */
interface CellInput extends SpreadsheetInput {
  /** Sheet name or index */
  sheet?: string | number;
  /** Cell reference (e.g., "A1") or range (e.g., "A1:B5") */
  cell: string;
  /** Value to set (for write operations) */
  value?: unknown;
  /** Formula to set (for write operations) */
  formula?: string;
}

/** Sheet operation input */
interface SheetInput extends SpreadsheetInput {
  /** Sheet name */
  sheetName?: string;
  /** New sheet name (for rename) */
  newName?: string;
  /** Sheet index (for operations by index) */
  index?: number;
}

/** Query input for filtering/sorting */
interface QueryInput extends SpreadsheetInput {
  /** Sheet name or index */
  sheet?: string | number;
  /** Filter expression (e.g., "Age > 30 AND Status = 'Active'") */
  filter?: string;
  /** Sort by column(s) */
  sortBy?: string | string[];
  /** Sort direction(s) */
  sortDirection?: "asc" | "desc" | ("asc" | "desc")[];
  /** Limit results */
  limit?: number;
  /** Skip rows */
  offset?: number;
  /** Use first row as headers */
  headers?: boolean;
}

// Helper to detect format from path.
const detectFormat = (path: string): SpreadsheetFormat => {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "xlsx") return "xlsx";
  if (ext === "xls") return "xls";
  if (ext === "csv") return "csv";
  return "xlsx";
};

// Helper to parse column reference.
const columnToIndex = (col: string): number => {
  let index = 0;
  for (let i = 0; i < col.length; i++) {
    index = index * 26 + (col.charCodeAt(i) - 64);
  }
  return index - 1;
};

const indexToColumn = (index: number): string => {
  let col = "";
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    col = String.fromCharCode(65 + remainder) + col;
    n = Math.floor((n - 1) / 26);
  }
  return col;
};

// Helper to parse cell reference.
const parseCell = (cell: string): { col: number; row: number } => {
  const match = cell.match(/^([A-Z]+)(\d+)$/i);
  if (!match) throw new Error(`Invalid cell reference: ${cell}`);
  return {
    col: columnToIndex(match[1].toUpperCase()),
    row: Number.parseInt(match[2], 10) - 1,
  };
};

/**
 * Read spreadsheet file.
 */
const read = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ReadInput;
    const format = input.format ?? detectFormat(input.path);

    if (format === "csv") {
      // Use papaparse for CSV.
      const Papa = await import("papaparse");
      const file = Bun.file(input.path);
      const text = await file.text();

      const result = Papa.default.parse(text, {
        header: input.headers ?? true,
        skipEmptyLines: true,
      });

      let data = result.data as Record<string, unknown>[];

      // Apply row limits.
      if (input.startRow !== undefined || input.endRow !== undefined) {
        const start = (input.startRow ?? 1) - 1;
        const end = input.endRow ?? data.length;
        data = data.slice(start, end);
      }

      return {
        success: true,
        output: {
          data,
          rowCount: data.length,
          headers: result.meta.fields,
          format: "csv",
        },
        durationMs: performance.now() - startTime,
      };
    }

    // Use xlsx for Excel files.
    const XLSX = await import("xlsx");
    const file = Bun.file(input.path);
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });

    // Get sheet.
    let sheetName: string;
    if (typeof input.sheet === "number") {
      sheetName = workbook.SheetNames[input.sheet] ?? workbook.SheetNames[0];
    } else {
      sheetName = input.sheet ?? workbook.SheetNames[0];
    }

    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      return {
        success: false,
        error: `Sheet not found: ${sheetName}`,
        durationMs: performance.now() - startTime,
      };
    }

    // Parse options.
    const options: XLSX.Sheet2JSONOpts = {
      header: input.headers === false ? 1 : undefined,
      range: input.startRow ? input.startRow - 1 : undefined,
    };

    let data = XLSX.utils.sheet_to_json(sheet, options) as Record<
      string,
      unknown
    >[];

    // Apply row limits.
    if (input.endRow !== undefined) {
      const startIdx = input.startRow ? 0 : 0;
      const endIdx = input.endRow - (input.startRow ?? 1);
      data = data.slice(startIdx, endIdx);
    }

    // Filter columns if specified.
    if (input.columns) {
      const cols = Array.isArray(input.columns)
        ? input.columns
        : input.columns.split(":").flatMap((c) => {
            if (c.includes("-")) {
              // Range like A-D.
              const [start, end] = c.split("-");
              const startIdx = columnToIndex(start);
              const endIdx = columnToIndex(end);
              return Array.from({ length: endIdx - startIdx + 1 }, (_, i) =>
                indexToColumn(startIdx + i),
              );
            }
            return [c];
          });

      // Get header row to map column letters to keys.
      const headerRow = XLSX.utils.sheet_to_json(sheet, { header: 1 })[0] as
        | string[]
        | undefined;
      if (headerRow && input.headers !== false) {
        const colIndices = cols.map((c) => columnToIndex(c));
        const selectedHeaders = colIndices
          .map((i) => headerRow[i])
          .filter(Boolean);
        data = data.map((row) => {
          const filtered: Record<string, unknown> = {};
          for (const header of selectedHeaders) {
            if (header in row) {
              filtered[header] = row[header];
            }
          }
          return filtered;
        });
      }
    }

    // Convert to requested format.
    let output: unknown;
    if (input.outputFormat === "array") {
      output = data.map((row) => Object.values(row));
    } else {
      output = data;
    }

    return {
      success: true,
      output: {
        data: output,
        rowCount: data.length,
        sheetName,
        sheetNames: workbook.SheetNames,
        format,
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
 * Write spreadsheet file.
 */
const write = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as WriteInput;
    const format = input.format ?? detectFormat(input.path);

    if (format === "csv") {
      const Papa = await import("papaparse");

      let data = input.data;
      if (
        Array.isArray(data) &&
        data.length > 0 &&
        !Array.isArray(data[0]) &&
        typeof data[0] === "object"
      ) {
        // Convert records to arrays.
        const records = data as Record<string, unknown>[];
        const headers = Object.keys(records[0]);
        const rows = records.map((r) => headers.map((h) => r[h]));
        if (input.includeHeaders !== false) {
          data = [headers, ...rows];
        } else {
          data = rows;
        }
      }

      const csv = Papa.default.unparse(data as unknown[][]);

      if (input.mode === "append") {
        const existing = await Bun.file(input.path).text().catch(() => "");
        await Bun.write(input.path, existing + "\n" + csv);
      } else {
        await Bun.write(input.path, csv);
      }

      return {
        success: true,
        output: {
          path: input.path,
          rowCount: (data as unknown[][]).length,
          format: "csv",
        },
        durationMs: performance.now() - startTime,
      };
    }

    const XLSX = await import("xlsx");

    let workbook: XLSX.WorkBook;
    if (input.mode === "append") {
      try {
        const existing = await Bun.file(input.path).arrayBuffer();
        workbook = XLSX.read(existing, { type: "array" });
      } catch {
        workbook = XLSX.utils.book_new();
      }
    } else {
      workbook = XLSX.utils.book_new();
    }

    // Prepare data.
    let sheetData: unknown[][];
    if (
      Array.isArray(input.data) &&
      input.data.length > 0 &&
      !Array.isArray(input.data[0]) &&
      typeof input.data[0] === "object"
    ) {
      const records = input.data as Record<string, unknown>[];
      const headers = Object.keys(records[0]);
      const rows = records.map((r) => headers.map((h) => r[h]));
      sheetData =
        input.includeHeaders !== false ? [headers, ...rows] : rows;
    } else {
      sheetData = input.data as unknown[][];
    }

    // Create or update sheet.
    const sheetName = input.sheet ?? "Sheet1";
    let sheet = workbook.Sheets[sheetName];

    if (!sheet || input.mode !== "append") {
      sheet = XLSX.utils.aoa_to_sheet(sheetData);
      if (workbook.SheetNames.includes(sheetName)) {
        workbook.Sheets[sheetName] = sheet;
      } else {
        XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
      }
    } else {
      // Append to existing sheet.
      const startCell = input.startCell ?? "A1";
      XLSX.utils.sheet_add_aoa(sheet, sheetData, { origin: startCell });
    }

    // Write file.
    const buffer = XLSX.write(workbook, { type: "array", bookType: format as XLSX.BookType });
    await Bun.write(input.path, buffer);

    return {
      success: true,
      output: {
        path: input.path,
        sheetName,
        rowCount: sheetData.length,
        format,
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
 * Get or set cell value.
 */
const cell = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as CellInput;
    const format = input.format ?? detectFormat(input.path);

    const XLSX = await import("xlsx");
    const fileData = await Bun.file(input.path).arrayBuffer();
    const workbook = XLSX.read(fileData, { type: "array" });

    let sheetName: string;
    if (typeof input.sheet === "number") {
      sheetName = workbook.SheetNames[input.sheet] ?? workbook.SheetNames[0];
    } else {
      sheetName = input.sheet ?? workbook.SheetNames[0];
    }

    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      return {
        success: false,
        error: `Sheet not found: ${sheetName}`,
        durationMs: performance.now() - startTime,
      };
    }

    // Check if it's a range.
    const isRange = input.cell.includes(":");
    const isWrite = input.value !== undefined || input.formula !== undefined;

    if (isWrite) {
      // Write operation.
      if (isRange) {
        return {
          success: false,
          error: "Cannot write to a range - specify a single cell",
          durationMs: performance.now() - startTime,
        };
      }

      const cellRef = parseCell(input.cell);
      const cellAddress = XLSX.utils.encode_cell({
        c: cellRef.col,
        r: cellRef.row,
      });

      if (input.formula) {
        sheet[cellAddress] = { f: input.formula };
      } else {
        sheet[cellAddress] = { v: input.value, t: typeof input.value === "number" ? "n" : "s" };
      }

      // Write back.
      const buffer = XLSX.write(workbook, { type: "array", bookType: format as XLSX.BookType });
      await Bun.write(input.path, buffer);

      return {
        success: true,
        output: {
          cell: input.cell,
          value: input.value,
          formula: input.formula,
        },
        durationMs: performance.now() - startTime,
      };
    }

    // Read operation.
    if (isRange) {
      const [start, end] = input.cell.split(":");
      const startCell = parseCell(start);
      const endCell = parseCell(end);

      const values: unknown[][] = [];
      for (let r = startCell.row; r <= endCell.row; r++) {
        const row: unknown[] = [];
        for (let c = startCell.col; c <= endCell.col; c++) {
          const addr = XLSX.utils.encode_cell({ c, r });
          const cellData = sheet[addr];
          row.push(cellData?.v ?? null);
        }
        values.push(row);
      }

      return {
        success: true,
        output: { range: input.cell, values },
        durationMs: performance.now() - startTime,
      };
    }

    const cellRef = parseCell(input.cell);
    const cellAddress = XLSX.utils.encode_cell({
      c: cellRef.col,
      r: cellRef.row,
    });
    const cellData = sheet[cellAddress];

    return {
      success: true,
      output: {
        cell: input.cell,
        value: cellData?.v ?? null,
        formula: cellData?.f,
        type: cellData?.t,
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
 * List sheets in workbook.
 */
const listSheets = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as SpreadsheetInput;
    const XLSX = await import("xlsx");

    const fileData = await Bun.file(input.path).arrayBuffer();
    const workbook = XLSX.read(fileData, { type: "array" });

    const sheets = workbook.SheetNames.map((name, index) => {
      const sheet = workbook.Sheets[name];
      const range = sheet["!ref"];
      return {
        name,
        index,
        range,
      };
    });

    return {
      success: true,
      output: { sheets, count: sheets.length },
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
 * Add a new sheet.
 */
const addSheet = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as SheetInput;
    const format = input.format ?? detectFormat(input.path);
    const XLSX = await import("xlsx");

    const fileData = await Bun.file(input.path).arrayBuffer();
    const workbook = XLSX.read(fileData, { type: "array" });

    const sheetName = input.sheetName ?? `Sheet${workbook.SheetNames.length + 1}`;

    if (workbook.SheetNames.includes(sheetName)) {
      return {
        success: false,
        error: `Sheet already exists: ${sheetName}`,
        durationMs: performance.now() - startTime,
      };
    }

    const sheet = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName);

    const buffer = XLSX.write(workbook, { type: "array", bookType: format as XLSX.BookType });
    await Bun.write(input.path, buffer);

    return {
      success: true,
      output: { sheetName, sheetCount: workbook.SheetNames.length },
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
 * Delete a sheet.
 */
const deleteSheet = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as SheetInput;
    const format = input.format ?? detectFormat(input.path);
    const XLSX = await import("xlsx");

    const fileData = await Bun.file(input.path).arrayBuffer();
    const workbook = XLSX.read(fileData, { type: "array" });

    const sheetName = input.sheetName ?? workbook.SheetNames[input.index ?? 0];

    if (!workbook.SheetNames.includes(sheetName)) {
      return {
        success: false,
        error: `Sheet not found: ${sheetName}`,
        durationMs: performance.now() - startTime,
      };
    }

    const idx = workbook.SheetNames.indexOf(sheetName);
    workbook.SheetNames.splice(idx, 1);
    delete workbook.Sheets[sheetName];

    const buffer = XLSX.write(workbook, { type: "array", bookType: format as XLSX.BookType });
    await Bun.write(input.path, buffer);

    return {
      success: true,
      output: { deleted: sheetName, sheetCount: workbook.SheetNames.length },
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
 * Rename a sheet.
 */
const renameSheet = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as SheetInput;
    if (!input.newName) {
      return {
        success: false,
        error: "newName is required",
        durationMs: performance.now() - startTime,
      };
    }

    const format = input.format ?? detectFormat(input.path);
    const XLSX = await import("xlsx");

    const fileData = await Bun.file(input.path).arrayBuffer();
    const workbook = XLSX.read(fileData, { type: "array" });

    const oldName = input.sheetName ?? workbook.SheetNames[input.index ?? 0];

    if (!workbook.SheetNames.includes(oldName)) {
      return {
        success: false,
        error: `Sheet not found: ${oldName}`,
        durationMs: performance.now() - startTime,
      };
    }

    const idx = workbook.SheetNames.indexOf(oldName);
    workbook.SheetNames[idx] = input.newName;
    workbook.Sheets[input.newName] = workbook.Sheets[oldName];
    delete workbook.Sheets[oldName];

    const buffer = XLSX.write(workbook, { type: "array", bookType: format as XLSX.BookType });
    await Bun.write(input.path, buffer);

    return {
      success: true,
      output: { oldName, newName: input.newName },
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
 * Query spreadsheet with filter/sort.
 */
const query = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as QueryInput;

    // First read the data.
    const readResult = await read(
      {
        path: input.path,
        format: input.format,
        sheet: input.sheet,
        headers: input.headers ?? true,
      },
      _context,
    );

    if (!readResult.success) {
      return readResult;
    }

    let data = (readResult.output as { data: Record<string, unknown>[] }).data;

    // Apply filter.
    if (input.filter) {
      // Simple expression parser for filters like "Age > 30 AND Status = 'Active'".
      const filterFn = (row: Record<string, unknown>): boolean => {
        const expr = input.filter!;

        // Split by AND/OR (simplified - doesn't handle nested).
        const conditions = expr.split(/\s+AND\s+/i);

        return conditions.every((cond) => {
          const match = cond.match(
            /^\s*(\w+)\s*(=|!=|>|<|>=|<=|LIKE)\s*['"]?([^'"]+)['"]?\s*$/i,
          );
          if (!match) return true;

          const [, field, op, value] = match;
          const fieldValue = row[field];

          switch (op.toUpperCase()) {
            case "=":
              return String(fieldValue) === value;
            case "!=":
              return String(fieldValue) !== value;
            case ">":
              return Number(fieldValue) > Number(value);
            case "<":
              return Number(fieldValue) < Number(value);
            case ">=":
              return Number(fieldValue) >= Number(value);
            case "<=":
              return Number(fieldValue) <= Number(value);
            case "LIKE":
              return String(fieldValue).includes(value.replace(/%/g, ""));
            default:
              return true;
          }
        });
      };

      data = data.filter(filterFn);
    }

    // Apply sort.
    if (input.sortBy) {
      const sortFields = Array.isArray(input.sortBy)
        ? input.sortBy
        : [input.sortBy];
      const directions = Array.isArray(input.sortDirection)
        ? input.sortDirection
        : [input.sortDirection ?? "asc"];

      data.sort((a, b) => {
        for (let i = 0; i < sortFields.length; i++) {
          const field = sortFields[i];
          const dir = directions[i] ?? "asc";
          const aVal = a[field];
          const bVal = b[field];

          let cmp = 0;
          if (typeof aVal === "number" && typeof bVal === "number") {
            cmp = aVal - bVal;
          } else {
            cmp = String(aVal ?? "").localeCompare(String(bVal ?? ""));
          }

          if (cmp !== 0) {
            return dir === "desc" ? -cmp : cmp;
          }
        }
        return 0;
      });
    }

    // Apply offset and limit.
    if (input.offset) {
      data = data.slice(input.offset);
    }
    if (input.limit) {
      data = data.slice(0, input.limit);
    }

    return {
      success: true,
      output: {
        data,
        rowCount: data.length,
        filter: input.filter,
        sortBy: input.sortBy,
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
 * Create new spreadsheet file.
 */
const create = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as SpreadsheetInput & {
      sheetName?: string;
    };
    const format = input.format ?? detectFormat(input.path);

    if (format === "csv") {
      await Bun.write(input.path, "");
      return {
        success: true,
        output: { path: input.path, format: "csv" },
        durationMs: performance.now() - startTime,
      };
    }

    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.book_append_sheet(workbook, sheet, input.sheetName ?? "Sheet1");

    const buffer = XLSX.write(workbook, { type: "array", bookType: format as XLSX.BookType });
    await Bun.write(input.path, buffer);

    return {
      success: true,
      output: { path: input.path, format },
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
 * Spreadsheet built-in plugin definition.
 */
export const spreadsheetPlugin: BuiltinPlugin = {
  id: "builtin:spreadsheet",
  name: "Spreadsheet",
  description: "Excel and CSV operations (read, write, query, cell operations)",
  actions: {
    read: {
      name: "read",
      description: "Read spreadsheet data",
      handler: read,
    },
    write: {
      name: "write",
      description: "Write data to spreadsheet",
      handler: write,
    },
    cell: {
      name: "cell",
      description: "Get or set cell value/formula",
      handler: cell,
    },
    query: {
      name: "query",
      description: "Query data with filter/sort",
      handler: query,
    },
    create: {
      name: "create",
      description: "Create new spreadsheet file",
      handler: create,
    },
    listSheets: {
      name: "listSheets",
      description: "List all sheets in workbook",
      handler: listSheets,
    },
    addSheet: {
      name: "addSheet",
      description: "Add a new sheet",
      handler: addSheet,
    },
    deleteSheet: {
      name: "deleteSheet",
      description: "Delete a sheet",
      handler: deleteSheet,
    },
    renameSheet: {
      name: "renameSheet",
      description: "Rename a sheet",
      handler: renameSheet,
    },
  },
};

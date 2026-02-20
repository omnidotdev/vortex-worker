/**
 * Built-in Google Sheets Plugin
 *
 * Full CRUD operations for Google Sheets.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Base input for all Google Sheets operations */
interface BaseInput {
  /** OAuth connection ID (references stored credentials) */
  connectionId?: string;
  /** Direct access token (alternative to connectionId) */
  accessToken?: string;
  /** Spreadsheet ID from the URL */
  spreadsheetId: string;
}

/** Read input */
interface ReadInput extends BaseInput {
  /** Sheet name (default: first sheet) */
  sheet?: string;
  /** A1 notation range (e.g., "A1:D10" or "Sheet1!A1:D10") */
  range?: string;
  /** Parse first row as headers */
  includeHeaders?: boolean;
}

/** Write input */
interface WriteInput extends BaseInput {
  /** Sheet name */
  sheet?: string;
  /** Starting cell in A1 notation */
  startCell?: string;
  /** Data to write */
  data: unknown[][] | Record<string, unknown>[];
  /** How to interpret input data */
  valueInputOption?: "RAW" | "USER_ENTERED";
  /** Include headers from object keys */
  includeHeaders?: boolean;
}

/** Append input */
interface AppendInput extends WriteInput {
  /** Table range to append to */
  tableRange?: string;
}

/** Update input */
interface UpdateInput extends BaseInput {
  /** Sheet name */
  sheet?: string;
  /** Range to update in A1 notation */
  range: string;
  /** Data to write */
  data: unknown[][] | Record<string, unknown>[];
  /** How to interpret input data */
  valueInputOption?: "RAW" | "USER_ENTERED";
}

/** Delete/Clear input */
interface DeleteInput extends BaseInput {
  /** Sheet name */
  sheet?: string;
  /** Range to clear in A1 notation */
  range: string;
}

/** Sheet operation input */
interface SheetInput extends BaseInput {
  /** Sheet name */
  sheetName?: string;
  /** New sheet name (for add) */
  newSheetName?: string;
  /** Sheet ID (for delete by ID) */
  sheetId?: number;
}

// Helper to get Google Sheets client.
const getClient = async (
  accessToken: string,
): Promise<{
  get: (url: string) => Promise<Response>;
  post: (url: string, body: unknown) => Promise<Response>;
  put: (url: string, body: unknown) => Promise<Response>;
}> => {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  return {
    get: (url: string) => fetch(url, { headers }),
    post: (url: string, body: unknown) =>
      fetch(url, { method: "POST", headers, body: JSON.stringify(body) }),
    put: (url: string, body: unknown) =>
      fetch(url, { method: "PUT", headers, body: JSON.stringify(body) }),
  };
};

const BASE_URL = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * Read data from Google Sheets.
 */
const read = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ReadInput;

    // Get access token from connection or direct input.
    const accessToken =
      input.accessToken ??
      (context?.connections?.[input.connectionId ?? ""]?.accessToken as
        | string
        | undefined);

    if (!accessToken) {
      return {
        success: false,
        error: "Access token required - provide connectionId or accessToken",
        durationMs: performance.now() - startTime,
      };
    }

    const client = await getClient(accessToken);

    // Build range string.
    let range = input.range ?? "";
    if (input.sheet && !range.includes("!")) {
      range = input.sheet + (range ? `!${range}` : "");
    }

    const url = range
      ? `${BASE_URL}/${input.spreadsheetId}/values/${encodeURIComponent(range)}`
      : `${BASE_URL}/${input.spreadsheetId}/values:batchGet`;

    const response = await client.get(url);

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `Google Sheets API error: ${error}`,
        durationMs: performance.now() - startTime,
      };
    }

    const result = (await response.json()) as {
      values?: unknown[][];
      valueRanges?: Array<{ values?: unknown[][] }>;
    };

    const values = result.values ?? result.valueRanges?.[0]?.values ?? [];

    // Convert to records if headers enabled.
    let data: unknown;
    if (input.includeHeaders !== false && values.length > 0) {
      const headers = values[0] as string[];
      const rows = values.slice(1);
      data = rows.map((row) => {
        const record: Record<string, unknown> = {};
        headers.forEach((header, i) => {
          record[header] = (row as unknown[])[i];
        });
        return record;
      });
    } else {
      data = values;
    }

    return {
      success: true,
      output: {
        data,
        rowCount: Array.isArray(data) ? data.length : 0,
        range,
        spreadsheetId: input.spreadsheetId,
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
 * Write data to Google Sheets (overwrites existing).
 */
const write = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as WriteInput;

    const accessToken =
      input.accessToken ??
      (context?.connections?.[input.connectionId ?? ""]?.accessToken as
        | string
        | undefined);

    if (!accessToken) {
      return {
        success: false,
        error: "Access token required - provide connectionId or accessToken",
        durationMs: performance.now() - startTime,
      };
    }

    const client = await getClient(accessToken);

    // Prepare data.
    let values: unknown[][];
    if (
      Array.isArray(input.data) &&
      input.data.length > 0 &&
      !Array.isArray(input.data[0]) &&
      typeof input.data[0] === "object"
    ) {
      const records = input.data as Record<string, unknown>[];
      const headers = Object.keys(records[0]);
      const rows = records.map((r) => headers.map((h) => r[h]));
      values = input.includeHeaders !== false ? [headers, ...rows] : rows;
    } else {
      values = input.data as unknown[][];
    }

    // Build range.
    const startCell = input.startCell ?? "A1";
    const range = input.sheet ? `${input.sheet}!${startCell}` : startCell;

    const url = `${BASE_URL}/${input.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=${input.valueInputOption ?? "USER_ENTERED"}`;

    const response = await client.put(url, { values });

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `Google Sheets API error: ${error}`,
        durationMs: performance.now() - startTime,
      };
    }

    const result = (await response.json()) as {
      updatedRows?: number;
      updatedCells?: number;
    };

    return {
      success: true,
      output: {
        updatedRows: result.updatedRows,
        updatedCells: result.updatedCells,
        range,
        spreadsheetId: input.spreadsheetId,
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
 * Append data to Google Sheets.
 */
const append = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as AppendInput;

    const accessToken =
      input.accessToken ??
      (context?.connections?.[input.connectionId ?? ""]?.accessToken as
        | string
        | undefined);

    if (!accessToken) {
      return {
        success: false,
        error: "Access token required - provide connectionId or accessToken",
        durationMs: performance.now() - startTime,
      };
    }

    const client = await getClient(accessToken);

    // Prepare data.
    let values: unknown[][];
    if (
      Array.isArray(input.data) &&
      input.data.length > 0 &&
      !Array.isArray(input.data[0]) &&
      typeof input.data[0] === "object"
    ) {
      const records = input.data as Record<string, unknown>[];
      const headers = Object.keys(records[0]);
      values = records.map((r) => headers.map((h) => r[h]));
      // Don't include headers for append - they should already exist.
    } else {
      values = input.data as unknown[][];
    }

    const range = input.tableRange ?? input.sheet ?? "Sheet1";

    const url = `${BASE_URL}/${input.spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=${input.valueInputOption ?? "USER_ENTERED"}&insertDataOption=INSERT_ROWS`;

    const response = await client.post(url, { values });

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `Google Sheets API error: ${error}`,
        durationMs: performance.now() - startTime,
      };
    }

    const result = (await response.json()) as {
      updates?: { updatedRows?: number; updatedCells?: number };
    };

    return {
      success: true,
      output: {
        appendedRows: result.updates?.updatedRows,
        appendedCells: result.updates?.updatedCells,
        range,
        spreadsheetId: input.spreadsheetId,
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
 * Update specific range in Google Sheets.
 */
const update = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as UpdateInput;

    const accessToken =
      input.accessToken ??
      (context?.connections?.[input.connectionId ?? ""]?.accessToken as
        | string
        | undefined);

    if (!accessToken) {
      return {
        success: false,
        error: "Access token required - provide connectionId or accessToken",
        durationMs: performance.now() - startTime,
      };
    }

    const client = await getClient(accessToken);

    // Prepare data.
    let values: unknown[][];
    if (
      Array.isArray(input.data) &&
      input.data.length > 0 &&
      !Array.isArray(input.data[0]) &&
      typeof input.data[0] === "object"
    ) {
      const records = input.data as Record<string, unknown>[];
      const headers = Object.keys(records[0]);
      values = records.map((r) => headers.map((h) => r[h]));
    } else {
      values = input.data as unknown[][];
    }

    const range = input.sheet ? `${input.sheet}!${input.range}` : input.range;

    const url = `${BASE_URL}/${input.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=${input.valueInputOption ?? "USER_ENTERED"}`;

    const response = await client.put(url, { values });

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `Google Sheets API error: ${error}`,
        durationMs: performance.now() - startTime,
      };
    }

    const result = (await response.json()) as {
      updatedRows?: number;
      updatedCells?: number;
    };

    return {
      success: true,
      output: {
        updatedRows: result.updatedRows,
        updatedCells: result.updatedCells,
        range,
        spreadsheetId: input.spreadsheetId,
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
 * Clear range in Google Sheets.
 */
const clear = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as DeleteInput;

    const accessToken =
      input.accessToken ??
      (context?.connections?.[input.connectionId ?? ""]?.accessToken as
        | string
        | undefined);

    if (!accessToken) {
      return {
        success: false,
        error: "Access token required - provide connectionId or accessToken",
        durationMs: performance.now() - startTime,
      };
    }

    const client = await getClient(accessToken);

    const range = input.sheet ? `${input.sheet}!${input.range}` : input.range;

    const url = `${BASE_URL}/${input.spreadsheetId}/values/${encodeURIComponent(range)}:clear`;

    const response = await client.post(url, {});

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `Google Sheets API error: ${error}`,
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: {
        cleared: true,
        range,
        spreadsheetId: input.spreadsheetId,
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
 * List sheets in spreadsheet.
 */
const listSheets = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as BaseInput;

    const accessToken =
      input.accessToken ??
      (context?.connections?.[input.connectionId ?? ""]?.accessToken as
        | string
        | undefined);

    if (!accessToken) {
      return {
        success: false,
        error: "Access token required - provide connectionId or accessToken",
        durationMs: performance.now() - startTime,
      };
    }

    const client = await getClient(accessToken);

    const url = `${BASE_URL}/${input.spreadsheetId}?fields=sheets.properties`;

    const response = await client.get(url);

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `Google Sheets API error: ${error}`,
        durationMs: performance.now() - startTime,
      };
    }

    const result = (await response.json()) as {
      sheets?: Array<{
        properties?: {
          sheetId?: number;
          title?: string;
          index?: number;
          gridProperties?: { rowCount?: number; columnCount?: number };
        };
      }>;
    };

    const sheets = result.sheets?.map((s) => ({
      id: s.properties?.sheetId,
      name: s.properties?.title,
      index: s.properties?.index,
      rowCount: s.properties?.gridProperties?.rowCount,
      columnCount: s.properties?.gridProperties?.columnCount,
    }));

    return {
      success: true,
      output: {
        sheets,
        count: sheets?.length ?? 0,
        spreadsheetId: input.spreadsheetId,
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
 * Add a new sheet.
 */
const addSheet = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as SheetInput;

    const accessToken =
      input.accessToken ??
      (context?.connections?.[input.connectionId ?? ""]?.accessToken as
        | string
        | undefined);

    if (!accessToken) {
      return {
        success: false,
        error: "Access token required - provide connectionId or accessToken",
        durationMs: performance.now() - startTime,
      };
    }

    const client = await getClient(accessToken);

    const url = `${BASE_URL}/${input.spreadsheetId}:batchUpdate`;

    const response = await client.post(url, {
      requests: [
        {
          addSheet: {
            properties: {
              title: input.newSheetName ?? input.sheetName ?? "New Sheet",
            },
          },
        },
      ],
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `Google Sheets API error: ${error}`,
        durationMs: performance.now() - startTime,
      };
    }

    const result = (await response.json()) as {
      replies?: Array<{
        addSheet?: { properties?: { sheetId?: number; title?: string } };
      }>;
    };

    const newSheet = result.replies?.[0]?.addSheet?.properties;

    return {
      success: true,
      output: {
        sheetId: newSheet?.sheetId,
        sheetName: newSheet?.title,
        spreadsheetId: input.spreadsheetId,
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
 * Delete a sheet.
 */
const deleteSheet = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as SheetInput;

    const accessToken =
      input.accessToken ??
      (context?.connections?.[input.connectionId ?? ""]?.accessToken as
        | string
        | undefined);

    if (!accessToken) {
      return {
        success: false,
        error: "Access token required - provide connectionId or accessToken",
        durationMs: performance.now() - startTime,
      };
    }

    if (input.sheetId === undefined) {
      return {
        success: false,
        error: "sheetId is required to delete a sheet",
        durationMs: performance.now() - startTime,
      };
    }

    const client = await getClient(accessToken);

    const url = `${BASE_URL}/${input.spreadsheetId}:batchUpdate`;

    const response = await client.post(url, {
      requests: [
        {
          deleteSheet: {
            sheetId: input.sheetId,
          },
        },
      ],
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `Google Sheets API error: ${error}`,
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: {
        deleted: true,
        sheetId: input.sheetId,
        spreadsheetId: input.spreadsheetId,
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
 * Google Sheets built-in plugin definition.
 */
export const googleSheetsPlugin: BuiltinPlugin = {
  id: "builtin:googleSheets",
  name: "Google Sheets",
  description: "Google Sheets operations (read, write, append, clear)",
  actions: {
    read: {
      name: "read",
      description: "Read data from Google Sheets",
      handler: read,
    },
    write: {
      name: "write",
      description: "Write data to Google Sheets (overwrites)",
      handler: write,
    },
    append: {
      name: "append",
      description: "Append rows to Google Sheets",
      handler: append,
    },
    update: {
      name: "update",
      description: "Update specific range",
      handler: update,
    },
    clear: {
      name: "clear",
      description: "Clear range contents",
      handler: clear,
    },
    listSheets: {
      name: "listSheets",
      description: "List all sheets in spreadsheet",
      handler: listSheets,
    },
    addSheet: {
      name: "addSheet",
      description: "Add a new sheet",
      handler: addSheet,
    },
    deleteSheet: {
      name: "deleteSheet",
      description: "Delete a sheet by ID",
      handler: deleteSheet,
    },
  },
};

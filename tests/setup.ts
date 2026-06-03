import { vi } from "vitest";

// Mock pg Pool
const mockResults: Map<string, { rows: Record<string, unknown>[] }> = new Map();
let lastQuery: { text: string; values: unknown[] } | null = null;

const INSERT_APIFY_ID = "00000000-0000-0000-0000-000000000099";

const mockPool = {
  query: vi.fn(async (text: string, values?: unknown[]) => {
    lastQuery = { text, values: values ?? [] };

    // Ingestion: single INSERT into the data/cache table returns the new id.
    if (text.includes("INSERT INTO apify_ahref")) {
      return { rows: [{ id: INSERT_APIFY_ID }] };
    }

    const key = findMatchingKey(text);
    if (key && mockResults.has(key)) {
      return mockResults.get(key)!;
    }
    return { rows: [] };
  }),
  connect: vi.fn(),
  end: vi.fn(),
};

const findMatchingKey = (text: string): string | undefined => {
  for (const key of mockResults.keys()) {
    if (text.includes(key)) return key;
  }
  return undefined;
};

export const setMockResult = (
  querySubstring: string,
  rows: Record<string, unknown>[]
) => {
  mockResults.set(querySubstring, { rows });
};

export const clearMocks = () => {
  mockResults.clear();
  lastQuery = null;
  mockPool.query.mockClear();
};

export const getLastQuery = () => lastQuery;
export const getMockPool = () => mockPool;
export const getInsertApifyId = () => INSERT_APIFY_ID;

// Mock the db module
vi.mock("../src/db", () => ({
  getPool: () => mockPool,
  setPool: vi.fn(),
  closePool: vi.fn(),
}));

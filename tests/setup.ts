import { vi } from "vitest";

// Mock pg Pool
const mockResults: Map<string, { rows: Record<string, unknown>[] }> = new Map();
let lastQuery: { text: string; values: unknown[] } | null = null;
let transactionQueries: { text: string; values: unknown[] }[] = [];

const mockClient = {
  query: vi.fn(async (text: string, values?: unknown[]) => {
    lastQuery = { text, values: values ?? [] };
    transactionQueries.push({ text, values: values ?? [] });

    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return { rows: [] };
    }
    if (text.includes("INSERT INTO apify_ahref")) {
      return {
        rows: [{ id: "00000000-0000-0000-0000-000000000099" }],
      };
    }
    if (text.includes("INSERT INTO ahref_outlets")) {
      return { rows: [] };
    }
    return { rows: [] };
  }),
  release: vi.fn(),
};

const mockPool = {
  query: vi.fn(async (text: string, values?: unknown[]) => {
    lastQuery = { text, values: values ?? [] };
    const key = findMatchingKey(text);
    if (key && mockResults.has(key)) {
      return mockResults.get(key)!;
    }
    return { rows: [] };
  }),
  connect: vi.fn(async () => mockClient),
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
  transactionQueries = [];
  mockPool.query.mockClear();
  mockClient.query.mockClear();
  mockClient.release.mockClear();
};

export const getLastQuery = () => lastQuery;
export const getTransactionQueries = () => transactionQueries;
export const getMockPool = () => mockPool;
export const getMockClient = () => mockClient;

// Mock the db module
vi.mock("../src/db", () => ({
  getPool: () => mockPool,
  setPool: vi.fn(),
  closePool: vi.fn(),
}));

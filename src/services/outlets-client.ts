export interface OutletsClientConfig {
  baseUrl: string;
  apiKey: string;
}

export const createOutletsClient = (config: OutletsClientConfig) => {
  const headers = {
    "x-api-key": config.apiKey,
    "Content-Type": "application/json",
  };

  return {
    getOutletsByCampaign: async (campaignId: string): Promise<string[]> => {
      const res = await fetch(
        `${config.baseUrl}/internal/outlets/by-campaign/${campaignId}`,
        { headers }
      );
      if (!res.ok) {
        throw new Error(
          `outlets-service responded with ${res.status}: ${await res.text()}`
        );
      }
      const data = (await res.json()) as { outletIds: string[] };
      return data.outletIds;
    },
  };
};

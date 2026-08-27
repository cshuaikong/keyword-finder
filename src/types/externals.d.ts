declare module 'global-agent' {
  export function bootstrap(): void;
}

declare module 'google-trends-api' {
  interface TrendsOptions {
    keyword: string;
    startTime?: Date;
    endTime?: Date;
    geo?: string;
    hl?: string;
  }

  interface RelatedQueriesResult {
    default: {
      rankedList: Array<{
        rankedKeyword: Array<{
          query: string;
          value: string | number;
        }>;
      }>;
    };
  }

  interface InterestOverTimeResult {
    default: {
      timelineData: Array<{
        time: string;
        value: number[];
      }>;
    };
  }

  const googleTrends: {
    relatedQueries(options: TrendsOptions): Promise<string>;
    interestOverTime(options: TrendsOptions): Promise<string>;
    dailyTrends(options?: { geo?: string }): Promise<string>;
    realTimeTrends(options?: { geo?: string; category?: string }): Promise<string>;
  };

  export default googleTrends;
}

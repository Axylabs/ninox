/**
 * Aggregation helpers shared by every op: `mergeAggOptions` (merge driver +
 * SDK options into a full `AggregateOptions`, forwarding `batchSize`) and the
 * `DATE_PART_FORMATS` lookup for date-bucket `$dateToString` formats.
 */
import type { AggregateOptions } from 'mongodb';
import type { AggregationSdkOptions, DateRangeConfig } from './types.ts';

/** Merge resolved SDK options into the driver's aggregate options. */
export const mergeAggOptions = (
  driverOpts: Record<string, unknown>,
  sdk: AggregationSdkOptions,
): AggregateOptions => ({
  ...(driverOpts as AggregateOptions),
  session: sdk.session,
  maxTimeMS: sdk.maxTimeMS,
  hint: sdk.hint,
  batchSize: sdk.batchSize,
});

/** `$dateToString` format per granularity for `dateRangeAnalysis`. */
export const DATE_PART_FORMATS: Record<NonNullable<DateRangeConfig['granularity']>, string> = {
  hour: '%Y-%m-%dT%H',
  day: '%Y-%m-%d',
  week: '%Y-W%V',
  month: '%Y-%m',
  year: '%Y',
};

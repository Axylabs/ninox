import { BSON, type Document } from 'mongodb';
import type { MongoJsonSchema } from '../json-schema.ts';
import { push } from './helpers.ts';
import type { DriftIssue } from './types.ts';

type RawSchema = MongoJsonSchema & {
  allOf?: RawSchema[];
  anyOf?: RawSchema[];
  oneOf?: RawSchema[];
  not?: RawSchema;
  patternProperties?: Record<string, RawSchema>;
  dependencies?: Record<string, string[] | RawSchema>;
};

const typeMatches = (value: unknown, type: string): boolean => {
  if (type === 'number') return typeof value === 'number' || value instanceof BSON.Long;
  if (type === 'int') {
    return value instanceof BSON.Int32 || (typeof value === 'number' && Number.isInteger(value));
  }
  if (type === 'long') {
    return value instanceof BSON.Long || (typeof value === 'number' && Number.isInteger(value));
  }
  if (type === 'double') return typeof value === 'number' || value instanceof BSON.Double;
  if (type === 'decimal') return value instanceof BSON.Decimal128;
  if (type === 'object')
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'bool' || type === 'boolean') return typeof value === 'boolean';
  if (type === 'date') return value instanceof Date;
  if (type === 'objectId') return value instanceof BSON.ObjectId;
  if (type === 'null') return value === null;
  if (type === 'binData') return value instanceof BSON.Binary;
  if (type === 'regex') return value instanceof RegExp;
  return true;
};

const comparable = (value: unknown): number | undefined => {
  if (typeof value === 'number') return value;
  if (value instanceof BSON.Long || value instanceof BSON.Int32 || value instanceof BSON.Double) {
    return Number(value.toString());
  }
  if (value instanceof BSON.Decimal128) return Number(value.toString());
  return undefined;
};

/** Validate the MongoDB JSON-schema keywords accepted by the raw escape hatch. */
export const validateRawSchema = (
  schema: RawSchema,
  value: unknown,
  path: string,
  issues: DriftIssue[],
): void => {
  const types = schema.bsonType === undefined ? [] : [schema.bsonType].flat();
  if (types.length > 0 && !types.some((type) => typeMatches(value, type))) {
    push(issues, path, 'type', types.join(' | '), 'BSON type does not match raw schema');
    return;
  }
  if (
    schema.enum &&
    !schema.enum.some(
      (candidate) => BSON.EJSON.stringify(candidate) === BSON.EJSON.stringify(value),
    )
  ) {
    push(issues, path, 'enum', 'raw enum', 'Value is not in the allowed set');
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      push(issues, path, 'constraint', `minLength ${schema.minLength}`, 'String is too short');
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      push(issues, path, 'constraint', `maxLength ${schema.maxLength}`, 'String is too long');
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      push(
        issues,
        path,
        'constraint',
        `pattern ${schema.pattern}`,
        'String does not match pattern',
      );
    }
  }

  const numeric = comparable(value);
  if (numeric !== undefined) {
    const minimum =
      typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : schema.minimum;
    const maximum =
      typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum : schema.maximum;
    if (
      minimum !== undefined &&
      (numeric < minimum || (schema.exclusiveMinimum === true && numeric === minimum))
    ) {
      push(issues, path, 'constraint', `minimum ${minimum}`, 'Number is below minimum');
    }
    if (
      maximum !== undefined &&
      (numeric > maximum || (schema.exclusiveMaximum === true && numeric === maximum))
    ) {
      push(issues, path, 'constraint', `maximum ${maximum}`, 'Number is above maximum');
    }
    if (
      schema.multipleOf !== undefined &&
      Math.abs(numeric / schema.multipleOf - Math.round(numeric / schema.multipleOf)) > 1e-9
    ) {
      push(
        issues,
        path,
        'constraint',
        `multipleOf ${schema.multipleOf}`,
        'Number is not a multiple',
      );
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      push(issues, path, 'constraint', `minItems ${schema.minItems}`, 'Array is too short');
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      push(issues, path, 'constraint', `maxItems ${schema.maxItems}`, 'Array is too long');
    }
    if (schema.uniqueItems) {
      const unique = new Set(value.map((item) => BSON.EJSON.stringify(item, { relaxed: false })));
      if (unique.size !== value.length) {
        push(issues, path, 'constraint', 'uniqueItems', 'Array contains duplicate items');
      }
    }
    if (Array.isArray(schema.items)) {
      schema.items.forEach((item, index) => {
        if (index < value.length)
          validateRawSchema(item, value[index], `${path}[${index}]`, issues);
      });
    } else if (schema.items) {
      value.forEach((item, index) => {
        validateRawSchema(schema.items as RawSchema, item, `${path}[${index}]`, issues);
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Document;
    for (const required of schema.required ?? []) {
      if (object[required] === undefined)
        push(issues, `${path}.${required}`, 'missing', 'required', 'Required field is missing');
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in object)
        validateRawSchema(child, object[key], path ? `${path}.${key}` : key, issues);
    }
    for (const [pattern, child] of Object.entries(schema.patternProperties ?? {})) {
      for (const key of Object.keys(object)) {
        if (new RegExp(pattern).test(key))
          validateRawSchema(child, object[key], `${path}.${key}`, issues);
      }
    }
    if (schema.additionalProperties === false) {
      const known = new Set([
        ...Object.keys(schema.properties ?? {}),
        ...Object.keys(object).filter((key) =>
          Object.keys(schema.patternProperties ?? {}).some((pattern) =>
            new RegExp(pattern).test(key),
          ),
        ),
      ]);
      for (const key of Object.keys(object)) {
        if (!known.has(key))
          push(
            issues,
            `${path}.${key}`,
            'unknown_key',
            'no additional properties',
            'Unexpected field',
          );
      }
    } else if (typeof schema.additionalProperties === 'object') {
      for (const key of Object.keys(object)) {
        if (!(key in (schema.properties ?? {})))
          validateRawSchema(schema.additionalProperties, object[key], `${path}.${key}`, issues);
      }
    }
    const count = Object.keys(object).length;
    if (schema.minProperties !== undefined && count < schema.minProperties)
      push(
        issues,
        path,
        'constraint',
        `minProperties ${schema.minProperties}`,
        'Too few properties',
      );
    if (schema.maxProperties !== undefined && count > schema.maxProperties)
      push(
        issues,
        path,
        'constraint',
        `maxProperties ${schema.maxProperties}`,
        'Too many properties',
      );
    for (const [key, dependency] of Object.entries(schema.dependencies ?? {})) {
      if (!(key in object)) continue;
      if (Array.isArray(dependency)) {
        for (const required of dependency)
          if (!(required in object))
            push(issues, path, 'constraint', 'dependencies', `${key} requires ${required}`);
      } else validateRawSchema(dependency, object, path, issues);
    }
  }

  for (const child of schema.allOf ?? []) validateRawSchema(child, value, path, issues);
  if (schema.anyOf) {
    const matches = schema.anyOf.some((child) => {
      const candidate: DriftIssue[] = [];
      validateRawSchema(child, value, path, candidate);
      return candidate.length === 0;
    });
    if (!matches) push(issues, path, 'constraint', 'anyOf', 'No anyOf schema matched');
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((child) => {
      const candidate: DriftIssue[] = [];
      validateRawSchema(child, value, path, candidate);
      return candidate.length === 0;
    }).length;
    if (matches !== 1)
      push(issues, path, 'constraint', 'oneOf', 'Exactly one oneOf schema must match');
  }
  if (schema.not) {
    const candidate: DriftIssue[] = [];
    validateRawSchema(schema.not, value, path, candidate);
    if (candidate.length === 0)
      push(issues, path, 'constraint', 'not', 'Value matched a forbidden schema');
  }
};

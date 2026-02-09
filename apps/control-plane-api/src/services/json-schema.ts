type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

interface ValidationIssue {
  path: string;
  message: string;
}

interface SchemaNode {
  type?: string | string[];
  required?: unknown;
  properties?: unknown;
  additionalProperties?: unknown;
  items?: unknown;
  enum?: unknown;
  const?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
}

const SUPPORTED_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSchemaNode(value: unknown): SchemaNode | null {
  if (!isPlainObject(value)) {
    return null;
  }
  return value as SchemaNode;
}

function valueType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (Number.isInteger(value)) {
    return "integer";
  }
  return typeof value;
}

function matchesType(expected: string, value: unknown): boolean {
  switch (expected) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function readTypes(schema: SchemaNode): string[] {
  if (typeof schema.type === "string") {
    return [schema.type];
  }
  if (Array.isArray(schema.type)) {
    return schema.type.filter((type): type is string => typeof type === "string");
  }
  return [];
}

function validateSchemaDefinitionNode(schema: unknown, path: string, issues: ValidationIssue[]): void {
  const node = toSchemaNode(schema);
  if (!node) {
    issues.push({ path, message: "Schema node must be an object" });
    return;
  }

  const types = readTypes(node);
  if (types.length > 0) {
    for (const type of types) {
      if (!SUPPORTED_TYPES.has(type)) {
        issues.push({ path: `${path}.type`, message: `Unsupported type '${type}'` });
      }
    }
  }

  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || node.required.some((item) => typeof item !== "string")) {
      issues.push({ path: `${path}.required`, message: "required must be an array of strings" });
    }
  }

  if (node.properties !== undefined) {
    if (!isPlainObject(node.properties)) {
      issues.push({ path: `${path}.properties`, message: "properties must be an object" });
    } else {
      for (const [propertyName, propertySchema] of Object.entries(node.properties)) {
        validateSchemaDefinitionNode(propertySchema, `${path}.properties.${propertyName}`, issues);
      }
    }
  }

  if (node.additionalProperties !== undefined) {
    const isValidType = typeof node.additionalProperties === "boolean" || isPlainObject(node.additionalProperties);
    if (!isValidType) {
      issues.push({
        path: `${path}.additionalProperties`,
        message: "additionalProperties must be a boolean or schema object"
      });
    }

    if (isPlainObject(node.additionalProperties)) {
      validateSchemaDefinitionNode(node.additionalProperties, `${path}.additionalProperties`, issues);
    }
  }

  if (node.items !== undefined) {
    if (!isPlainObject(node.items)) {
      issues.push({ path: `${path}.items`, message: "items must be a schema object" });
    } else {
      validateSchemaDefinitionNode(node.items, `${path}.items`, issues);
    }
  }

  if (node.enum !== undefined && !Array.isArray(node.enum)) {
    issues.push({ path: `${path}.enum`, message: "enum must be an array" });
  }

  if (node.minLength !== undefined && (!Number.isInteger(node.minLength) || Number(node.minLength) < 0)) {
    issues.push({ path: `${path}.minLength`, message: "minLength must be a non-negative integer" });
  }
  if (node.maxLength !== undefined && (!Number.isInteger(node.maxLength) || Number(node.maxLength) < 0)) {
    issues.push({ path: `${path}.maxLength`, message: "maxLength must be a non-negative integer" });
  }
  if (node.minimum !== undefined && (typeof node.minimum !== "number" || !Number.isFinite(node.minimum))) {
    issues.push({ path: `${path}.minimum`, message: "minimum must be a finite number" });
  }
  if (node.maximum !== undefined && (typeof node.maximum !== "number" || !Number.isFinite(node.maximum))) {
    issues.push({ path: `${path}.maximum`, message: "maximum must be a finite number" });
  }
  if (node.minItems !== undefined && (!Number.isInteger(node.minItems) || Number(node.minItems) < 0)) {
    issues.push({ path: `${path}.minItems`, message: "minItems must be a non-negative integer" });
  }
  if (node.maxItems !== undefined && (!Number.isInteger(node.maxItems) || Number(node.maxItems) < 0)) {
    issues.push({ path: `${path}.maxItems`, message: "maxItems must be a non-negative integer" });
  }
}

function validateValueNode(schema: unknown, value: unknown, path: string, issues: ValidationIssue[]): void {
  const node = toSchemaNode(schema);
  if (!node) {
    issues.push({ path, message: "Schema node is invalid" });
    return;
  }

  const types = readTypes(node);
  if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
    const actualType = valueType(value);
    issues.push({ path, message: `Expected type ${types.join("|")}, got ${actualType}` });
    return;
  }

  if (node.const !== undefined && value !== node.const) {
    issues.push({ path, message: "Value must match const" });
  }

  if (Array.isArray(node.enum) && !node.enum.some((item) => item === value)) {
    issues.push({ path, message: "Value must be one of enum values" });
  }

  if (typeof value === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) {
      issues.push({ path, message: `String is shorter than minLength ${node.minLength}` });
    }
    if (typeof node.maxLength === "number" && value.length > node.maxLength) {
      issues.push({ path, message: `String is longer than maxLength ${node.maxLength}` });
    }
  }

  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) {
      issues.push({ path, message: `Number is lower than minimum ${node.minimum}` });
    }
    if (typeof node.maximum === "number" && value > node.maximum) {
      issues.push({ path, message: `Number is greater than maximum ${node.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) {
      issues.push({ path, message: `Array has fewer than minItems ${node.minItems}` });
    }
    if (typeof node.maxItems === "number" && value.length > node.maxItems) {
      issues.push({ path, message: `Array has more than maxItems ${node.maxItems}` });
    }

    if (node.items !== undefined) {
      value.forEach((item, index) => {
        validateValueNode(node.items, item, `${path}[${index}]`, issues);
      });
    }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(node.properties)
      ? (node.properties as Record<string, unknown>)
      : ({} as Record<string, unknown>);
    const required = Array.isArray(node.required)
      ? node.required.filter((item): item is string => typeof item === "string")
      : [];

    for (const requiredKey of required) {
      if (!(requiredKey in value)) {
        issues.push({ path, message: `Missing required property '${requiredKey}'` });
      }
    }

    for (const [propertyName, propertyValue] of Object.entries(value)) {
      const propertySchema = properties[propertyName];
      if (propertySchema) {
        validateValueNode(propertySchema, propertyValue, `${path}.${propertyName}`, issues);
        continue;
      }

      if (node.additionalProperties === false) {
        issues.push({ path: `${path}.${propertyName}`, message: "Additional properties are not allowed" });
        continue;
      }

      if (isPlainObject(node.additionalProperties)) {
        validateValueNode(node.additionalProperties, propertyValue, `${path}.${propertyName}`, issues);
      }
    }
  }
}

export function validateSchemaDefinition(schema: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateSchemaDefinitionNode(schema, "$", issues);
  return issues;
}

export function validateInputAgainstSchema(schema: unknown, value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateValueNode(schema, value, "$", issues);
  return issues;
}

const SUPPORTED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function valueMatchesType(value, type) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function coercePrimitive(value, type, path) {
  if (type === 'string' && typeof value === 'number' && Number.isFinite(value)) {
    return { value: String(value) };
  }
  if ((type === 'string' || type === 'integer' || type === 'number') && typeof value === 'string' && value.trim() !== '') {
    if (type === 'string') return { value: value };
    const numeric = Number(value);
    if (Number.isFinite(numeric) && (type === 'number' || Number.isInteger(numeric))) {
      return { value: numeric };
    }
    return { error: path + ' must be a ' + type };
  }
  if (type === 'number' && typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return { value: numeric };
  }
  return null;
}

function validateValue(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return value;
  if (schema.type && !SUPPORTED_TYPES.has(schema.type)) {
    errors.push(path + ' has unsupported schema type ' + schema.type);
    return value;
  }

  let current = value;

  if (current === undefined || current === null) {
    if (schema.default !== undefined) return schema.default;
    return current;
  }

  if (schema.type && !valueMatchesType(current, schema.type)) {
    const coerced = coercePrimitive(current, schema.type, path);
    if (coerced && 'error' in coerced) {
      errors.push(coerced.error);
      return current;
    }
    if (coerced) {
      current = coerced.value;
    } else if (schema.default !== undefined) {
      return schema.default;
    } else {
      errors.push(path + ' must be of type ' + schema.type + ' (received ' + describeType(current) + ')');
      return current;
    }
  }

  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.some((allowed) => allowed === current)) {
      errors.push(path + ' must be one of: ' + schema.enum.join(', '));
    }
  }

  if (schema.type === 'string' || typeof current === 'string') {
    if (typeof current === 'string') {
      const length = Array.from(current).length;
      if (schema.minLength !== undefined && length < schema.minLength) {
        errors.push(path + ' must contain at least ' + schema.minLength + ' character(s)');
      }
      if (schema.maxLength !== undefined && length > schema.maxLength) {
        errors.push(path + ' must contain at most ' + schema.maxLength + ' character(s)');
      }
      if (schema.pattern instanceof RegExp && !schema.pattern.test(current)) {
        errors.push(path + ' has an invalid format');
      }
    }
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof current === 'number') {
      if (schema.minimum !== undefined && current < schema.minimum) {
        errors.push(path + ' must be >= ' + schema.minimum);
      }
      if (schema.maximum !== undefined && current > schema.maximum) {
        errors.push(path + ' must be <= ' + schema.maximum);
      }
    }
  }

  if (schema.format === 'path' && typeof current === 'string') {
    if (current.includes(String.fromCharCode(0)) || current.split(String.fromCharCode(92)).join('/').split('/').includes('..')) {
      errors.push(path + ' must not contain parent-directory segments');
    }
  }

  if (schema.type === 'array' && Array.isArray(current)) {
    if (schema.minItems !== undefined && current.length < schema.minItems) {
      errors.push(path + ' must contain at least ' + schema.minItems + ' item(s)');
    }
    if (schema.maxItems !== undefined && current.length > schema.maxItems) {
      errors.push(path + ' must contain at most ' + schema.maxItems + ' item(s)');
    }
    if (schema.items) {
      const items = current.map((item, index) => validateValue(item, schema.items, path + '[' + index + ']', errors));
      current = items;
    }
  }

  if (schema.type === 'object' && valueMatchesType(current, 'object')) {
    const properties = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const output = {};
    const unknown = [];

    required.forEach((key) => {
      if (current[key] === undefined || current[key] === null) {
        errors.push(path + '.' + key + ' is required');
      }
    });

    Object.keys(current).forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        unknown.push(key);
      }
    });

    if (schema.additionalProperties === false && unknown.length > 0) {
      errors.push(path + ' has unexpected properties: ' + unknown.join(', '));
    }

    Object.keys(properties).forEach((key) => {
      const childSchema = properties[key];
      const result = validateValue(current[key], childSchema, path + '.' + key, errors);
      if (result !== undefined) output[key] = result;
    });

    if (schema.additionalProperties === false) return output;
    Object.keys(current).forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(output, key) && current[key] !== undefined) {
        output[key] = current[key];
      }
    });
    return output;
  }

  return current;
}

export function validate(schema, input) {
  const errors = [];
  let source = input;
  if (source === undefined || source === null) {
    if (schema && schema.default !== undefined) return { ok: true, value: schema.default };
    source = {};
  }
  if (schema && schema.type === 'object' && !valueMatchesType(source, 'object')) {
    errors.push('$ must be of type object (received ' + describeType(source) + ')');
    return { ok: false, errors: errors };
  }
  const value = validateValue(source, schema, '$', errors);
  if (errors.length > 0) return { ok: false, errors: errors };
  return { ok: true, value: value };
}

export default { validate };

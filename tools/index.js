import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_EXTENSIONS = new Set(['.js', '.mjs']);

function isToolModule(fileName) {
  if (!MODULE_EXTENSIONS.has(path.extname(fileName))) return false;
  if (fileName === 'index.js' || fileName.startsWith('_')) return false;
  return true;
}

function toolFiles(directory) {
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && isToolModule(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

export async function loadRegistry(options) {
  const settings = options || {};
  const directory = settings.directory || path.dirname(fileURLToPath(import.meta.url));
  const registry = new Map();
  const files = toolFiles(directory);
  const errors = [];

  for (const file of files) {
    let module;
    try {
      module = await import(pathToFileURL(file).href);
    } catch (err) {
      errors.push({ file: file, message: err && err.message ? err.message : String(err) });
      continue;
    }
    const exported = module.default && typeof module.default === 'object' ? module.default : module;
    const toolName = exported.name;
    const toolSchema = exported.schema;
    const toolHandler = exported.handler;
    const fileName = path.basename(file, path.extname(file));

    if (typeof toolName !== 'string' || toolName.length === 0) {
      errors.push({ file: file, message: 'Tool module does not export a name' });
      continue;
    }
    if (toolName !== fileName) {
      errors.push({ file: file, message: 'Tool name "' + toolName + '" does not match file name "' + fileName + '"' });
      continue;
    }
    if (!toolSchema || typeof toolSchema !== 'object' || toolSchema.type !== 'object') {
      errors.push({ file: file, message: 'Tool schema must be a JSON-schema object' });
      continue;
    }
    if (typeof toolHandler !== 'function') {
      errors.push({ file: file, message: 'Tool handler must be a function' });
      continue;
    }
    if (typeof exported.run !== 'function') {
      errors.push({ file: file, message: 'Tool must export a run() wrapper created from the shared runner' });
      continue;
    }
    if (registry.has(toolName)) {
      const previous = registry.get(toolName);
      errors.push({ file: file, message: 'Duplicate tool name "' + toolName + '" (already registered from ' + previous.file + ')' });
      continue;
    }
    registry.set(toolName, {
      name: toolName,
      file: file,
      schema: toolSchema,
      handler: toolHandler,
      run: exported.run
    });
  }

  if (errors.length > 0) {
    const summary = errors.map((item) => path.basename(item.file) + ': ' + item.message).join('; ');
    const error = new Error('Tool registry failed to load: ' + summary);
    error.code = 'E_VALIDATION';
    error.details = errors;
    throw error;
  }

  return registry;
}

export function registryToOpenAiTools(registry) {
  const tools = [];
  registry.forEach((tool) => {
    tools.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.schema.description || 'Tool ' + tool.name,
        parameters: {
          type: 'object',
          properties: tool.schema.properties || {},
          required: Array.isArray(tool.schema.required) ? tool.schema.required : [],
          additionalProperties: tool.schema.additionalProperties === false ? false : true
        }
      }
    });
  });
  return tools;
}

export async function runTool(registry, toolName, input, context) {
  if (!registry.has(toolName)) {
    return { ok: false, error: { code: 'E_VALIDATION', message: 'Unknown tool: ' + String(toolName) } };
  }
  const tool = registry.get(toolName);
  return tool.run(input, context);
}

let cached = null;

export async function getRegistry(options) {
  if (!cached || (options && options.fresh)) {
    cached = await loadRegistry(options);
  }
  return cached;
}

export async function getOpenAiTools() {
  return registryToOpenAiTools(await getRegistry());
}

export async function invoke(name, input, context) {
  return runTool(await getRegistry(), name, input, context);
}

export default { loadRegistry, getRegistry, runTool, registryToOpenAiTools, getOpenAiTools, invoke };
